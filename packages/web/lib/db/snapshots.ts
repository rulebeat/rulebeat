import { eq, and, or, inArray, notInArray, gte, lte, lt, ne, desc, min, max, sql, getTableColumns, type SQL } from 'drizzle-orm';
import { db } from './client';
import {
  postureSnapshots as snapshotsTable, findings as findingsTable, suppressions as suppressionsTable, categories as categoriesTable,
} from './tables';
import { many, run, inConsistentWrite, type DbHandle } from './exec';
import { getCategory, listCategories } from './categories';
import { loadRules } from '../rules';
import { isActiveSuppression } from '../suppressions';
import { listHierarchyNodes } from './management-group-hierarchy';
import { wholeSubscriptionIds, type Access } from '../access-model';
import { DIRECTORY_SUBSCRIPTION } from '../placement';
import { SNAPSHOTS_BACKFILL_MARKER } from './scan-findings-copy';
import { setMeta } from './meta';
import { SEVERITY_ORDER } from '../severity';
import { countsInFindingTotalsSql } from './finding-kinds-sql';
import { knownSubscriptions } from '../known-subscriptions';
import { categoryPoints, FINDING_COUNT_VERSION, INSTALL_LEVEL } from '../trend-point-counts';
import { TREND_KEPT_DAYS } from '../widget-limits';
import type { Severity } from '../types';

const RETENTION_DAYS = TREND_KEPT_DAYS;

/** The posture formula a freshly-written row is computed under: bump this whenever the
 *  formula changes so a baseline comparison (spec 033) can tell old rows apart from new ones and
 *  exclude what it can't honestly compare against, instead of silently blending the two. */
export const SNAPSHOT_FORMULA_VERSION = 2;

export interface DailySnapshot {
  category: string;
  subscriptionId: string; // '' = aggregate row (all subscriptions)
  date: string;
  posturePct: number | null;
  passingRules: number;
  totalRules: number;
  /** Zero findings but the rule's last real run wasn't a proven success (or it never ran),
   *  neither passing nor failing (spec 030). 0 on every row written before this column existed,
   *  meaning "not distinguished then", not "genuinely none". */
  unknownRules: number;
  /** 'activity'-kind rules enabled for this category, excluded from totalRules entirely. They
   *  can never be scored the same way (no meaningful "zero findings" passing state). */
  activityRuleCount: number;
  /** Which posture formula computed this row's pct/passingRules/totalRules: see
   *  SNAPSHOT_FORMULA_VERSION. 1 on every row written before this column existed. */
  formulaVersion: number;
  /** Which definition of the finding count produced `activeFindings` and `severityCounts`: see
   *  FINDING_COUNT_VERSION. 0 on every row written before the column existed, meaning "not recorded". */
  findingCountVersion: number;
  activeFindings: number;
  severityCounts: Record<Severity, number>;
  updatedAt: string;
}

type Row = typeof snapshotsTable.$inferSelect;

function rowToSnapshot(row: Row): DailySnapshot {
  return {
    category: row.category,
    subscriptionId: row.subscriptionId,
    date: row.date,
    posturePct: row.posturePct,
    passingRules: row.passingRules,
    totalRules: row.totalRules,
    unknownRules: row.unknownRules,
    activityRuleCount: row.activityRuleCount,
    formulaVersion: row.formulaVersion,
    findingCountVersion: row.findingCountVersion,
    activeFindings: row.activeFindings,
    severityCounts: JSON.parse(row.severityCounts) as Record<Severity, number>,
    updatedAt: row.updatedAt,
  };
}

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// --- the one queued writer (ADR 0001, ADR 0013) ---

/** The writer's queue. On globalThis because the instrumentation hook and the route handlers can each load
 *  their own copy of this module, and two queues would not serialize each other. */
const writerQueue = ((globalThis as typeof globalThis & { __rulebeatTrendWriter?: { tail: Promise<void> } })
  .__rulebeatTrendWriter ??= { tail: Promise.resolve() });

/**
 * Recomputes today's (UTC) trend points of each category from live state: the only writer of
 * `posture_snapshots`. Every posture input calls it once its own transaction has committed (a scan's
 * sync, a rule or suppression write, a tree refresh that changed), and the startup call refreshes every
 * category.
 *
 * It writes only the UTC day of `now`. Production callers pass none; the Demo's replay passes its simulated
 * day. A day before it is never written, updated or deleted here, apart from retention.
 *
 * Calls are queued in this process (one replica, ADR 0001) and each reads live state when its turn starts,
 * so overlapping calls serialize and the last write reflects the latest state. It opens its own
 * transaction per category and is never nested in the caller's: on Postgres a read here would not see rows
 * the caller's transaction has not committed, and on SQLite the caller would hold the lock this waits for.
 * A failure is caught and logged, never thrown, so the action that called it is not failed.
 */
export function refreshSnapshotsFor(categories: readonly string[], now?: Date): Promise<void> {
  const ids = [...new Set(categories)];
  // writeTodaysPoints() catches its own failures; the catch is for the queue itself, which one rejection must never stop.
  // The default clock is read when the turn starts, so a call that waited behind a slow one writes the day it runs on.
  const turn = writerQueue.tail.then(() => writeTodaysPoints(ids, now ?? new Date())).catch(err => {
    console.error('[trend] The trend point writer failed:', err);
  });
  writerQueue.tail = turn;
  return turn;
}

async function writeTodaysPoints(categoryIds: string[], now: Date): Promise<void> {
  for (const id of categoryIds) {
    try {
      await inConsistentWrite(tx => writeCategoryPoints(tx, id, now));
    } catch (err) {
      console.error(`[trend] Could not write today's trend points for category "${id}":`, err);
    }
  }
  try {
    await enforceRetention(now);
  } catch (err) {
    console.error('[trend] Could not remove trend points past retention:', err);
  }
}

type PointInsert = typeof snapshotsTable.$inferInsert;

function severityJson(counts: Record<Severity, number>): string {
  return JSON.stringify(Object.fromEntries(SEVERITY_ORDER.map(sev => [sev, counts[sev] ?? 0])));
}

/** Whether a computed point reads differently from the newest earlier point at its level. */
function differsFrom(point: PointInsert, earlier: Row | undefined): boolean {
  if (!earlier) return true;
  return point.passingRules !== earlier.passingRules
    || point.totalRules !== earlier.totalRules
    || point.unknownRules !== earlier.unknownRules
    || point.activityRuleCount !== earlier.activityRuleCount
    || point.activeFindings !== earlier.activeFindings
    || point.severityCounts !== severityJson(JSON.parse(earlier.severityCounts) as Record<Severity, number>)
    || point.formulaVersion !== earlier.formulaVersion
    || point.findingCountVersion !== earlier.findingCountVersion;
}

/** The newest point before `today` at each level of a category, keyed by the level in lower case. When two rows
 *  of one level share that date in different cases, the most recently updated one is the level's point. */
async function newestEarlierPoints(tx: DbHandle, category: string, today: string): Promise<Map<string, Row>> {
  const newest = tx.select({
    level: sql<string>`lower(${snapshotsTable.subscriptionId})`.as('level_key'),
    date: max(snapshotsTable.date).as('newest_date'),
  }).from(snapshotsTable)
    .where(and(eq(snapshotsTable.category, category), lt(snapshotsTable.date, today)))
    .groupBy(sql`lower(${snapshotsTable.subscriptionId})`)
    .as('newest');
  const rows = await many(tx.select(getTableColumns(snapshotsTable)).from(snapshotsTable)
    .innerJoin(newest, and(sql`lower(${snapshotsTable.subscriptionId}) = ${newest.level}`, eq(snapshotsTable.date, newest.date)))
    .where(eq(snapshotsTable.category, category))) as unknown as Row[];
  const out = new Map<string, Row>();
  for (const row of rows) {
    const level = row.subscriptionId.toLowerCase();
    const seen = out.get(level);
    if (!seen || row.updatedAt > seen.updatedAt) out.set(level, row);
  }
  return out;
}

const WRITE_BATCH = 100;

/** One category's points for the UTC day of `now`, all read and written on the transaction `tx`. A category that
 *  no longer exists writes nothing. */
async function writeCategoryPoints(tx: DbHandle, categoryId: string, now: Date): Promise<void> {
  if (!await getCategory(categoryId, tx)) return;

  const today = toDateKey(now);
  const rules = await loadRules(tx);
  const hierarchy = await listHierarchyNodes(tx);

  // A stored point is an install-wide value, so it is computed over Everything, never under whoever caused the write.
  const suppressed = new Set(
    (await many(tx.select().from(suppressionsTable)))
      .filter(s => isActiveSuppression({ expiresAt: s.expiresAt ?? undefined })).map(s => s.fingerprint),
  );
  const active = await many(tx.select({
    fingerprint: findingsTable.fingerprint, ruleId: findingsTable.ruleId, severity: findingsTable.severity,
    subscriptionId: findingsTable.subscriptionId, placement: findingsTable.placement,
  }).from(findingsTable)
    .where(and(eq(findingsTable.category, categoryId), eq(findingsTable.status, 'active'), countsInFindingTotalsSql)));
  const findings = active.filter(f => !suppressed.has(f.fingerprint));

  // The shared subscription list: the tree's, those an enabled rule names, and those holding an active
  // Problem finding in any category.
  const holders = await many(tx.selectDistinct({ subscriptionId: findingsTable.subscriptionId }).from(findingsTable)
    .where(and(eq(findingsTable.status, 'active'), countsInFindingTotalsSql, ne(findingsTable.placement, 'directory'))));
  const known = knownSubscriptions({ hierarchy, rules, findingSubscriptions: holders.map(h => h.subscriptionId) });

  const todays = await many(tx.select({ subscriptionId: snapshotsTable.subscriptionId }).from(snapshotsTable)
    .where(and(eq(snapshotsTable.category, categoryId), eq(snapshotsTable.date, today))));
  const todayLevels = new Set(todays.map(r => r.subscriptionId.toLowerCase()));
  // A level whose point exists today is rewritten even when it has left the list (its findings all went), so
  // the point does not keep a count that is no longer true.
  const listed = new Set(known.map(sub => sub.key));
  const subscriptions = [
    ...known,
    ...[...todayLevels].filter(level => level !== INSTALL_LEVEL && level !== DIRECTORY_SUBSCRIPTION && !listed.has(level))
      .map(level => ({ key: level, id: level, name: null })),
  ];

  const computed = categoryPoints({ categoryId, rules, findings, subscriptions, hierarchy });

  const earlier = await newestEarlierPoints(tx, categoryId, today);

  const updatedAt = now.toISOString();
  const toWrite: PointInsert[] = [];
  for (const [level, counts] of computed) {
    const point: PointInsert = {
      category: categoryId,
      subscriptionId: level,
      date: today,
      posturePct: counts.posturePct,
      passingRules: counts.passingRules,
      totalRules: counts.totalRules,
      unknownRules: counts.unknownRules,
      activityRuleCount: counts.activityRuleCount,
      formulaVersion: SNAPSHOT_FORMULA_VERSION,
      findingCountVersion: FINDING_COUNT_VERSION,
      activeFindings: counts.activeFindings,
      severityCounts: severityJson(counts.severityCounts),
      updatedAt,
    };
    // The install-wide point is written every time. A level is written when today's point exists (it is
    // overwritten) or when it reads differently from its newest earlier point; a missing point means "unchanged".
    if (level === INSTALL_LEVEL || todayLevels.has(level) || differsFrom(point, earlier.get(level))) toWrite.push(point);
  }

  // A level stored today in another case is the same level: replace that row rather than hold two.
  const keys = new Set(toWrite.map(p => p.subscriptionId));
  for (const row of todays) {
    if (row.subscriptionId !== row.subscriptionId.toLowerCase() && keys.has(row.subscriptionId.toLowerCase())) {
      await run(tx.delete(snapshotsTable).where(and(
        eq(snapshotsTable.category, categoryId), eq(snapshotsTable.date, today), eq(snapshotsTable.subscriptionId, row.subscriptionId),
      )));
    }
  }

  for (let i = 0; i < toWrite.length; i += WRITE_BATCH) {
    await run(tx.insert(snapshotsTable).values(toWrite.slice(i, i + WRITE_BATCH)).onConflictDoUpdate({
      target: [snapshotsTable.category, snapshotsTable.subscriptionId, snapshotsTable.date],
      set: {
        posturePct: sql.raw('excluded.posture_pct'),
        passingRules: sql.raw('excluded.passing_rules'),
        totalRules: sql.raw('excluded.total_rules'),
        unknownRules: sql.raw('excluded.unknown_rules'),
        activityRuleCount: sql.raw('excluded.activity_rule_count'),
        formulaVersion: sql.raw('excluded.formula_version'),
        findingCountVersion: sql.raw('excluded.finding_count_version'),
        activeFindings: sql.raw('excluded.active_findings'),
        severityCounts: sql.raw('excluded.severity_counts'),
        updatedAt: sql.raw('excluded.updated_at'),
      },
    }));
  }
}

/**
 * Removes points older than 365 days, keeping each (category, level)'s newest point older than the
 * cutoff, so a baseline at the edge of the window still has a point to stand on. The level is compared in
 * lower case, and a category that no longer exists keeps nothing. One statement, the same shape on both
 * backends. Today's and every recent point are untouched.
 */
async function enforceRetention(now: Date): Promise<void> {
  const cutoff = toDateKey(new Date(now.getTime() - RETENTION_DAYS * 86_400_000));
  await run(db.delete(snapshotsTable).where(and(
    lt(snapshotsTable.date, cutoff),
    or(
      notInArray(snapshotsTable.category, db.select({ id: categoriesTable.id }).from(categoriesTable)),
      sql`${snapshotsTable.date} < (
        SELECT max(newer.date) FROM posture_snapshots newer
        WHERE newer.category = ${snapshotsTable.category}
          AND lower(newer.subscription_id) = lower(${snapshotsTable.subscriptionId})
          AND newer.date < ${cutoff}
      )`,
    ),
  )));
}

/** `subscriptionId` omitted (or '') queries the aggregate (all-subscriptions) row. The only
 *  granularity that existed before Phase 5. Pass a specific subscription id to get that
 *  subscription's own trend history instead, or the Directory's reserved value for the Directory's.
 *  The level is compared without regard to case, and when two rows of one category share a date (a
 *  level written in two cases by older code) the most recently updated one is the day's point.
 *
 *  Anyone who does not hold Everything is never given the aggregate row, which counts every finding
 *  on the install, and gets a subscription's row only for one they hold whole (#274), or the
 *  Directory's if they hold the Directory. A resource group Scope holds no whole subscription, so it
 *  reads nothing here. */
export async function getSnapshots(access: Access, opts: { categories?: string[]; subscriptionId?: string; sinceDate?: string } = {}): Promise<DailySnapshot[]> {
  const subscription = subscriptionCondition(access, opts.subscriptionId);
  if (!subscription) return [];
  const conditions = [subscription];
  if (opts.categories && opts.categories.length > 0) conditions.push(inArray(snapshotsTable.category, opts.categories));
  if (opts.sinceDate) conditions.push(gte(snapshotsTable.date, opts.sinceDate));

  const rows = await many(db.select().from(snapshotsTable).where(and(...conditions))
    .orderBy(snapshotsTable.date, snapshotsTable.updatedAt, snapshotsTable.subscriptionId));

  // Oldest update first, so the last row seen for a category and date is the day's point.
  const byDay = new Map<string, Row>();
  for (const row of rows) byDay.set(`${row.category}\u0000${row.date}`, row);
  return [...byDay.values()].map(rowToSnapshot);
}

/** The condition on a snapshot's subscription for one person, or null when they may read none of it.
 *  Compared as lower case on both sides. Everything reads exactly what it asked for. Anyone else reads a
 *  subscription held whole, or the Directory if they hold it, and never the aggregate. */
function subscriptionCondition(access: Access, subscriptionId: string | undefined): SQL | null {
  const level = (subscriptionId ?? '').toLowerCase();
  if (!access.everything) {
    const readable = level === DIRECTORY_SUBSCRIPTION ? access.directory : wholeSubscriptionIds(access).includes(level);
    if (!level || !readable) return null;
  }
  return sql`lower(${snapshotsTable.subscriptionId}) = ${level}`;
}

/** Latest row per category on or before `onOrBefore`: used as the delta baseline. Defaults to
 *  the aggregate (all-subscriptions) row; pass `subscriptionId` for a per-subscription baseline.
 *  Narrowed like `getSnapshots`. With `formulaVersions`, only rows of those formula versions are
 *  considered, so a category's latest row is its latest comparable one (trend-version-equality.ts). */
export async function getBaselineSnapshots(categories: string[], onOrBefore: string, access: Access, subscriptionId?: string, formulaVersions?: readonly number[]): Promise<DailySnapshot[]> {
  if (categories.length === 0) return [];
  const subscription = subscriptionCondition(access, subscriptionId);
  if (!subscription) return [];
  const rows = await many(db.select().from(snapshotsTable)
    .where(and(
      inArray(snapshotsTable.category, categories),
      subscription,
      lte(snapshotsTable.date, onOrBefore),
      ...(formulaVersions ? [inArray(snapshotsTable.formulaVersion, [...formulaVersions])] : []),
    ))
    .orderBy(desc(snapshotsTable.date), desc(snapshotsTable.updatedAt), desc(snapshotsTable.subscriptionId)));

  const seen = new Set<string>();
  const out: DailySnapshot[] = [];
  for (const row of rows) {
    if (seen.has(row.category)) continue;
    seen.add(row.category);
    out.push(rowToSnapshot(row));
  }
  return out;
}

/** The date of each category's oldest row of one of `formulaVersions`, narrowed like `getSnapshots`.
 *  A category with no such row is absent. Tells a withheld baseline how far back a comparison could
 *  ever reach. */
export async function getFirstSnapshotDates(categories: string[], access: Access, subscriptionId: string | undefined, formulaVersions: readonly number[]): Promise<Map<string, string>> {
  const first = new Map<string, string>();
  const subscription = subscriptionCondition(access, subscriptionId);
  if (categories.length === 0 || !subscription) return first;
  const rows = await many(db.select({ category: snapshotsTable.category, first: min(snapshotsTable.date) })
    .from(snapshotsTable)
    .where(and(
      inArray(snapshotsTable.category, categories),
      subscription,
      inArray(snapshotsTable.formulaVersion, [...formulaVersions]),
    ))
    .groupBy(snapshotsTable.category));
  for (const row of rows) if (row.first) first.set(row.category, row.first);
  return first;
}

// --- startup ---

/**
 * What runs at every start: one queued refresh of today for every category, so a suppression that expired
 * while RuleBeat was stopped, or a rule changed by the upgrade, counts from this start.
 *
 * It no longer approximates past days from the scan blobs. Those points were guesses (no unknown split, no
 * last-run check) written dated before the upgrade under the current formula, and an upgrade never writes a
 * past-dated point (ADR 0013). Points an earlier release already backfilled stay as they are.
 *
 * It still sets SNAPSHOTS_BACKFILL_MARKER: ADR 0008's sequence empties a scan's blob only once this marker
 * and the findings one are both set.
 */
export async function backfillSnapshots(): Promise<void> {
  const categories = await listCategories();
  await refreshSnapshotsFor(categories.map(c => c.id));
  await setMeta(SNAPSHOTS_BACKFILL_MARKER, '1');
}
