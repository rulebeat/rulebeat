import { and, eq, inArray, sql } from 'drizzle-orm';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { dbKind } from './backend';
import { chunk } from './chunk';
import type { DbHandle } from './exec';
import * as sqliteSchema from './schema';
import * as pgSchema from './schema.pg';

/**
 * The one module that writes the trend record (ADR 0012): cell and rule fact change rows, the Recorded day
 * marker and `trend_state`. A row is written only when its key's value differs from the key's newest row, so
 * recounting is idempotent and the record is a list of changes, not a list of days.
 *
 * Everything here is a *script*: a generator that yields the queries it needs and is given their results. A
 * script has no idea which backend runs it, so the same body serves a SQLite start (synchronous, inside
 * `runSeeds()`), a Postgres start (`seedPg()`) and a writer inside `inTransaction()`; the three drivers below
 * only differ in how they terminate a query. The queries are Drizzle builders on the handle the caller's
 * transaction gave, never the module-level `db`, so every write commits or rolls back with the change it records.
 */

/**
 * The Postgres advisory lock the record is written under. Taken as the last step before the recount, after any
 * name lock (`RULE_NAME_LOCK_KEY` and the like), and held only for the reads, record inserts and `trend_state`
 * updates that follow: a concurrent writer recounting the same keys waits here and then sees the first writer's
 * rows. Taking it first, or holding it across anything slow, would queue every writer and could deadlock
 * against a name lock. On SQLite the writer lock already serialises them. A value no other `*_LOCK_KEY` uses
 * (`advisory-lock-keys.test.ts`).
 */
export const TREND_RECORD_LOCK_KEY = 7194826201;

/** What the record stores, bumped by any change to it. Written on every Recorded day marker. */
export const TREND_RECORD_VERSION = 1;

/** How far back an install's finding events are kept before the upgrade, in days (ADR 0012). */
const EVENT_RETENTION_BEFORE_UPGRADE_DAYS = 180;

export interface CoveredEntry {
  category: string;
  tenantId: string;
  /** Null is Everything. */
  path: string | null;
  /** Null is every enabled rule in the category. */
  ruleIds: string[] | null;
}

/** What a writer throws when the record could not be written. The transaction it was thrown in rolls back, so the
 *  action it recorded is not saved either (ADR 0012); the cause is logged by whoever reports it, never shown. */
export class TrendRecordWriteError extends Error {
  constructor(cause: unknown) {
    super('The trend record could not be written.', { cause });
    this.name = 'TrendRecordWriteError';
  }
}

/** What Run History says of a scan whose record write failed. */
export const TREND_RECORD_FAILED_MESSAGE = 'Trend history could not be recorded, so this scan\'s results were not saved.';

export interface RecountResult {
  /** Cell rows written. */
  cells: number;
  /** Rule fact rows written. */
  facts: number;
}

export interface TrendStartResult extends RecountResult {
  /** True when this start found no `trend_state` row. */
  first: boolean;
}

// ---- Scripts ----

/**
 * The tables a script reads and writes, as the SQLite twin types them. The SQLite start is handed the SQLite
 * tables and the Postgres start the Postgres ones, whatever backend the process picked for everything else
 * (`tables.ts`), because `runSeeds()` and `seedPg()` work on the database they were given. A writer inside
 * `inTransaction()` is on the process's own backend.
 */
type Tables = Pick<typeof sqliteSchema, 'findings' | 'rules' | 'suppressions' | 'findingEvents' | 'trendCells' | 'trendRuleFacts' | 'trendRecordedDays' | 'trendState'>;
const SQLITE_TABLES: Tables = sqliteSchema;
const PG_TABLES = pgSchema as unknown as Tables;

/** The handle a script's queries are built on, and the tables they are built from. */
interface Ctx { tx: DbHandle; t: Tables }
const processCtx = (tx: DbHandle): Ctx => ({ tx, t: dbKind === 'pg' ? PG_TABLES : SQLITE_TABLES });

interface Step { op: 'all' | 'run' | 'lock'; query?: unknown; tx?: DbHandle }
type Script<T> = Generator<Step, T, unknown>;

function* all<T>(query: { all(): T[] }): Script<T[]> {
  return (yield { op: 'all', query }) as T[];
}

function* run(query: { run(): unknown }): Script<void> {
  yield { op: 'run', query };
}

function* takeRecordLock({ tx }: Ctx): Script<void> {
  yield { op: 'lock', tx };
}

/** Runs a script whose queries all finish at once: the SQLite driver. */
function driveSync<T>(script: Script<T>): T {
  let step = script.next();
  while (!step.done) {
    const { op, query } = step.value;
    step = script.next(op === 'all' ? (query as { all(): unknown }).all() : op === 'run' ? (query as { run(): unknown }).run() : undefined);
  }
  return step.value;
}

/** Runs a script on the handle of a transaction already open, Postgres when `pg` and SQLite otherwise. Never waits
 *  on anything but the database, so it is safe while the backend is still being brought up (`dbReady` is not awaited). */
async function driveAsync<T>(script: Script<T>, pg: boolean): Promise<T> {
  let step = script.next();
  while (!step.done) {
    const { op, query, tx } = step.value;
    let result: unknown;
    if (op === 'lock') {
      if (pg) {
        await (tx as unknown as { execute(query: unknown): Promise<unknown> }).execute(sql.raw(`SELECT pg_advisory_xact_lock(${TREND_RECORD_LOCK_KEY})`));
      }
    } else if (pg) {
      result = await (query as PromiseLike<unknown>);
    } else {
      result = op === 'all' ? (query as { all(): unknown }).all() : (query as { run(): unknown }).run();
    }
    step = script.next(result);
  }
  return step.value;
}

// ---- Cells ----

interface CellKey {
  ruleId: string;
  placement: string;
  subscriptionId: string;
  resourceGroup: string;
  managementGroupId: string;
  severity: string;
}
interface CellCounts extends CellKey { openCount: number; suppressedCount: number }
type CellRow = CellCounts & { seq: number; changedAt: string };

const cellKey = (c: CellKey): string =>
  [c.ruleId, c.placement, c.subscriptionId, c.resourceGroup, c.managementGroupId, c.severity].join('\u0000');

/** Rule ids as runs short enough for one `IN (...)`, or one run with no limit when no rules are named. */
const ruleRuns = (ruleIds: readonly string[] | undefined): (string[] | undefined)[] => (ruleIds ? chunk([...ruleIds]) : [undefined]);

/**
 * What the findings hold now, per cell: the open findings of a Problem rule that no active suppression
 * covers, and the ones one does. The place columns are lowercased with `''` for none, the way an access
 * filter compares them. A finding of a rule that is no longer there is counted by nobody, which is what takes a
 * deleted rule's cells to 0.
 */
function* readCurrentCells({ tx, t }: Ctx, nowIso: string, ruleIds: readonly string[] | undefined): Script<CellCounts[]> {
  const { rules, suppressions } = t;
  const f = t.findings;
  const subscription = sql<string>`lower(${f.subscriptionId})`;
  const group = sql<string>`lower(coalesce(${f.resourceGroup}, ''))`;
  const managementGroup = sql<string>`lower(coalesce(${f.managementGroupId}, ''))`;
  const suppressed = sql`${f.fingerprint} in (select ${suppressions.fingerprint} from ${suppressions} where ${suppressions.expiresAt} is null or ${suppressions.expiresAt} > ${nowIso})`;
  const out: CellCounts[] = [];
  for (const ids of ruleRuns(ruleIds)) {
    out.push(...(yield* all(tx.select({
      ruleId: f.ruleId,
      placement: f.placement,
      subscriptionId: subscription,
      resourceGroup: group,
      managementGroupId: managementGroup,
      severity: f.severity,
      openCount: sql<number>`cast(sum(case when ${suppressed} then 0 else 1 end) as integer)`,
      suppressedCount: sql<number>`cast(sum(case when ${suppressed} then 1 else 0 end) as integer)`,
    }).from(f).innerJoin(rules, eq(rules.id, f.ruleId))
      .where(and(eq(f.status, 'active'), eq(f.kind, 'state'), eq(rules.kind, 'state'), ids ? inArray(f.ruleId, ids) : undefined))
      .groupBy(f.ruleId, f.placement, subscription, group, managementGroup, f.severity))));
  }
  return out;
}

/** The newest row of each cell key. A key's rows are never dated backwards, so its highest `seq` is its newest. */
function* readNewestCells({ tx, t }: Ctx, ruleIds: readonly string[] | undefined): Script<CellRow[]> {
  const c = t.trendCells;
  const out: CellRow[] = [];
  for (const ids of ruleRuns(ruleIds)) {
    const newest = tx.select({ seq: sql<number>`max(${c.seq})` }).from(c)
      .where(ids ? inArray(c.ruleId, ids) : undefined)
      .groupBy(c.ruleId, c.placement, c.subscriptionId, c.resourceGroup, c.managementGroupId, c.severity);
    out.push(...(yield* all(tx.select().from(c).where(inArray(c.seq, newest)))));
  }
  return out;
}

// ---- Rule facts ----

interface RuleFacts {
  ruleId: string;
  enabled: boolean;
  kind: string;
  severity: string;
  scope: string;
  runningVersion: string | null;
  lastRunStatus: string | null;
  deleted: boolean;
}
type FactRow = RuleFacts & { seq: number; changedAt: string };

function* readCurrentFacts({ tx, t }: Ctx, ruleIds: readonly string[] | undefined): Script<RuleFacts[]> {
  const { rules } = t;
  const out: RuleFacts[] = [];
  for (const ids of ruleRuns(ruleIds)) {
    const stored = yield* all(tx.select({
      ruleId: rules.id, enabled: rules.enabled, kind: rules.kind, severity: rules.severity, scope: rules.scope,
      runningVersion: rules.version, lastRunStatus: rules.lastRunStatus,
    }).from(rules).where(ids ? inArray(rules.id, ids) : undefined));
    out.push(...stored.map(r => ({ ...r, deleted: false })));
  }
  return out;
}

function* readNewestFacts({ tx, t: tables }: Ctx, ruleIds: readonly string[] | undefined): Script<FactRow[]> {
  const t = tables.trendRuleFacts;
  const out: FactRow[] = [];
  for (const ids of ruleRuns(ruleIds)) {
    const newest = tx.select({ seq: sql<number>`max(${t.seq})` }).from(t).where(ids ? inArray(t.ruleId, ids) : undefined).groupBy(t.ruleId);
    out.push(...(yield* all(tx.select().from(t).where(inArray(t.seq, newest)))));
  }
  return out;
}

const sameFacts = (a: RuleFacts, b: RuleFacts): boolean =>
  a.enabled === b.enabled && a.kind === b.kind && a.severity === b.severity && a.scope === b.scope
  && a.runningVersion === b.runningVersion && a.lastRunStatus === b.lastRunStatus && a.deleted === b.deleted;

// ---- Recount ----

/** Rows per insert: a row binds up to 14 values and SQLite has historically allowed 999 in a statement. */
const INSERT_ROWS = 50;

/** The date a row is written under: the clock, moved up to the key's newest row so no key is dated backwards. */
const datedAt = (nowIso: string, newest: { changedAt: string } | undefined): string =>
  newest && newest.changedAt > nowIso ? newest.changedAt : nowIso;

/**
 * Reads the live inputs for `ruleIds` (every rule when undefined), compares them with each key's newest row and
 * inserts the keys that differ. A rule that is gone gets its cells written down to 0 and a deletion fact; its
 * last labels are not known here, so a caller that has them writes them.
 */
function* recountScript(c: Ctx, nowIso: string, ruleIds: readonly string[] | undefined): Script<RecountResult> {
  const currentCells = yield* readCurrentCells(c, nowIso, ruleIds);
  const newestCells = new Map((yield* readNewestCells(c, ruleIds)).map(r => [cellKey(r), r]));
  const cellRows: (CellCounts & { changedAt: string })[] = [];
  for (const cell of currentCells) {
    const key = cellKey(cell);
    const newest = newestCells.get(key);
    newestCells.delete(key);
    // A cell the findings hold has at least one finding, so one with no row yet is always a change.
    if (!newest || newest.openCount !== cell.openCount || newest.suppressedCount !== cell.suppressedCount) {
      cellRows.push({ ...cell, changedAt: datedAt(nowIso, newest) });
    }
  }
  for (const newest of newestCells.values()) {
    if (newest.openCount === 0 && newest.suppressedCount === 0) continue;
    const { seq: _seq, ...key } = newest;
    cellRows.push({ ...key, openCount: 0, suppressedCount: 0, changedAt: datedAt(nowIso, newest) });
  }

  const currentFacts = yield* readCurrentFacts(c, ruleIds);
  const newestFacts = new Map((yield* readNewestFacts(c, ruleIds)).map(r => [r.ruleId, r]));
  const factRows: (RuleFacts & { changedAt: string })[] = [];
  for (const facts of currentFacts) {
    const newest = newestFacts.get(facts.ruleId);
    newestFacts.delete(facts.ruleId);
    if (!newest || !sameFacts(newest, facts)) factRows.push({ ...facts, changedAt: datedAt(nowIso, newest) });
  }
  for (const newest of newestFacts.values()) {
    if (newest.deleted) continue;
    const { seq: _seq, ...facts } = newest;
    factRows.push({ ...facts, deleted: true, changedAt: datedAt(nowIso, newest) });
  }

  for (const batch of chunk(cellRows, INSERT_ROWS)) yield* run(c.tx.insert(c.t.trendCells).values(batch));
  for (const batch of chunk(factRows, INSERT_ROWS)) yield* run(c.tx.insert(c.t.trendRuleFacts).values(batch));
  return { cells: cellRows.length, facts: factRows.length };
}

// ---- Recorded day marker ----

const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

const coverageKey = (e: CoveredEntry): string => JSON.stringify([e.category, e.tenantId, e.path]);

/**
 * Coverage entries merged by category, tenant and path. The rule ids of entries that share all three are
 * unioned, and null (every enabled rule in the category) absorbs any list. Sorted, so the same coverage always
 * stores as the same text.
 */
export function mergeCovered(existing: readonly CoveredEntry[], added: readonly CoveredEntry[]): CoveredEntry[] {
  const merged = new Map<string, CoveredEntry>();
  for (const entry of [...existing, ...added]) {
    const key = coverageKey(entry);
    const have = merged.get(key);
    if (!have) {
      merged.set(key, { ...entry, ruleIds: entry.ruleIds ? [...new Set(entry.ruleIds)].sort() : null });
    } else {
      have.ruleIds = have.ruleIds === null || entry.ruleIds === null ? null : [...new Set([...have.ruleIds, ...entry.ruleIds])].sort();
    }
  }
  return [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, entry]) => entry);
}

/** Writes today's marker if it is not there yet, and merges `covered` into the day's coverage. */
function* markerScript({ tx, t }: Ctx, now: Date, covered: readonly CoveredEntry[]): Script<void> {
  const { trendRecordedDays } = t;
  const day = dayOf(now);
  const [existing] = yield* all(tx.select().from(trendRecordedDays).where(eq(trendRecordedDays.day, day)).limit(1));
  if (!existing) {
    yield* run(tx.insert(trendRecordedDays).values({
      day, recordVersion: TREND_RECORD_VERSION, firstRecordedAt: now.toISOString(), covered: JSON.stringify(mergeCovered([], covered)),
    }));
    return;
  }
  if (covered.length === 0) return;
  const merged = JSON.stringify(mergeCovered(JSON.parse(existing.covered) as CoveredEntry[], covered));
  if (merged !== existing.covered) yield* run(tx.update(trendRecordedDays).set({ covered: merged }).where(eq(trendRecordedDays.day, day)));
}

// ---- Start ----

/**
 * What a start does, in one transaction under the record lock: recount every key, make sure today has its
 * marker, and create `trend_state` on the first start. The first start (no `trend_state` row) therefore writes the current non-zero
 * cells, every rule's facts and the first marker, which is the state as of now and never a backfill; every
 * later start writes only what differs, and the count of what it wrote is what the caller warns about.
 */
function* startScript(c: Ctx, now: Date): Script<TrendStartResult> {
  const { tx, t } = c;
  const { trendState, findingEvents } = t;
  const nowIso = now.toISOString();
  yield* takeRecordLock(c);
  const first = (yield* all(tx.select({ id: trendState.id }).from(trendState).where(eq(trendState.id, 1)).limit(1))).length === 0;
  const result = yield* recountScript(c, nowIso, undefined);
  yield* markerScript(c, now, []);
  if (first) {
    // Events are kept for the 180 days before the upgrade when there are any, so a window never claims days the
    // events cannot show; with none, the record and the events begin together.
    const hasEvents = (yield* all(tx.select({ id: findingEvents.id }).from(findingEvents).limit(1))).length > 0;
    const keptSince = hasEvents ? dayOf(new Date(now.getTime() - EVENT_RETENTION_BEFORE_UPGRADE_DAYS * 86_400_000)) : dayOf(now);
    yield* run(tx.insert(trendState).values({ id: 1, eventsKeptSince: keptSince }));
  }
  return { first, ...result };
}

/** The one line a start that corrected the record logs: counts only, never an id, a place or a date. */
function reportCorrections(result: TrendStartResult): void {
  if (result.first || result.cells + result.facts === 0) return;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  console.warn(`[rulebeat] trend history: the start recount corrected ${plural(result.cells, 'cell', 'cells')} and ${plural(result.facts, 'rule fact', 'rule facts')} that had not been recorded`);
}

/** What a failed start costs: a line in the log. The record is then only as right as its last write, and the next
 *  write or the next start's recount corrects it (ADR 0012, limit 3); refusing to boot would cost the customer more. */
function reportFailure(err: unknown): void {
  console.error('[rulebeat] trend history: the start could not record, so the record may be behind until the next recount:', err instanceof Error ? err.message : String(err));
}

/** The SQLite start, called from `runSeeds()`: synchronous, so the record is there before anything else runs. */
export function startTrendRecording(sqlite: Database.Database, now: Date = new Date()): TrendStartResult | undefined {
  const ctx: Ctx = { tx: drizzle(sqlite) as unknown as DbHandle, t: SQLITE_TABLES };
  try {
    const result = sqlite.transaction(() => driveSync(startScript(ctx, now))).immediate();
    reportCorrections(result);
    return result;
  } catch (err) {
    reportFailure(err);
    return undefined;
  }
}

/** The Postgres start, called from `seedPg()`. */
export async function startTrendRecordingPg(
  database: { transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> },
  now: Date = new Date(),
): Promise<TrendStartResult | undefined> {
  try {
    const result = await database.transaction(tx => driveAsync(startScript({ tx: tx as DbHandle, t: PG_TABLES }, now), true));
    reportCorrections(result);
    return result;
  } catch (err) {
    reportFailure(err);
    return undefined;
  }
}

// ---- Writers inside a transaction ----

/**
 * Recounts the cells and facts of `ruleIds`, or of every rule when none are named, and inserts the keys that
 * differ, dated by `now` (the action's clock) or the key's newest row if that is later. Call it inside the
 * transaction of the change it records, after any name lock; it takes the record lock itself.
 */
export async function recountTrend(tx: DbHandle, opts: { ruleIds?: readonly string[]; now?: Date } = {}): Promise<RecountResult> {
  const nowIso = (opts.now ?? new Date()).toISOString();
  const c = processCtx(tx);
  return driveAsync((function* (): Script<RecountResult> {
    yield* takeRecordLock(c);
    return yield* recountScript(c, nowIso, opts.ruleIds);
  })(), dbKind === 'pg');
}

/** Writes the Recorded day marker of `now`'s UTC day if it is not there, and merges `covered` into its coverage. */
export async function recordRecordedDay(tx: DbHandle, opts: { now?: Date; covered?: readonly CoveredEntry[] } = {}): Promise<void> {
  const c = processCtx(tx);
  return driveAsync((function* (): Script<void> {
    yield* takeRecordLock(c);
    yield* markerScript(c, opts.now ?? new Date(), opts.covered ?? []);
  })(), dbKind === 'pg');
}
