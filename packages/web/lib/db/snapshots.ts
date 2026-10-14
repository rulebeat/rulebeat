import { eq, and, inArray, gte, lte, lt, desc, sql, type SQL } from 'drizzle-orm';
import { db } from './client';
import { postureSnapshots as snapshotsTable, findings as findingsTable } from './tables';
import { many, run } from './exec';
import { getCategory, listCategories } from './categories';
import { loadRules } from '../rules';
import { loadSuppressions, isActiveSuppression } from '../suppressions';
import { SYSTEM_ACCESS } from '../system-access';
import { wholeSubscriptionIds, type Access } from '../access-model';
import { loadStoredScanBlobs } from './scan-blob-history';
import { SNAPSHOTS_BACKFILL_MARKER } from './scan-findings-copy';
import { getMeta, setMeta } from './meta';
import { emptySeverityCounts } from '../severity';
import { countsTowardPosture, isActivityRule } from '../finding-kinds';
import { countsInFindingTotalsSql } from './finding-kinds-sql';
import type { Severity } from '../types';

const RETENTION_DAYS = 365;

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
    activeFindings: row.activeFindings,
    severityCounts: JSON.parse(row.severityCounts) as Record<Severity, number>,
    updatedAt: row.updatedAt,
  };
}

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Recomputes and upserts today's (UTC) row(s) for a category from the live findings table. An
 *  aggregate row (subscriptionId '') plus one row per subscription that currently has an active
 *  finding in this category (same "only knowable via live findings" limitation as
 *  dashboard-data.ts's `perSubscription`: a subscription that reaches zero findings simply stops
 *  getting a fresh row rather than writing an explicit 100%/0-findings row). */
export async function upsertDailySnapshot(categoryId: string, now: Date = new Date()): Promise<void> {
  const category = await getCategory(categoryId);
  if (!category) return;

  const enabledRules = (await loadRules()).filter(r => r.enabled && r.category === categoryId);
  const stateRules = enabledRules.filter(countsTowardPosture);
  const stateRuleIds = new Set(stateRules.map(r => r.id));
  const ruleById = new Map(enabledRules.map(r => [r.id, r]));
  const totalRules = stateRules.length;
  const activityRuleCount = enabledRules.filter(isActivityRule).length;

  // An activity finding's ruleId never matches stateRuleIds below, so including it here doesn't
  // affect failingRuleIds.
  const activeRows = await many(db.select().from(findingsTable)
    .where(and(eq(findingsTable.category, categoryId), eq(findingsTable.status, 'active'), countsInFindingTotalsSql)));

  // A stored snapshot is an install-wide value, so it is computed under SYSTEM_ACCESS, never under
  // whoever triggered the scan or backfill.
  const suppressedFingerprints = new Set(
    (await loadSuppressions(SYSTEM_ACCESS)).filter(isActiveSuppression).map(s => s.fingerprint),
  );
  const visible = activeRows.filter(f => !suppressedFingerprints.has(f.fingerprint));

  const date = toDateKey(now);
  const updatedAt = now.toISOString();

  async function upsertRow(subscriptionId: string, rows: typeof visible): Promise<void> {
    const severityCounts = emptySeverityCounts();
    for (const f of rows) {
      const sev = f.severity as Severity;
      if (sev in severityCounts) severityCounts[sev]++;
    }

    // A rule only counts as passing if it has zero findings here AND its last real run actually
    // succeeded: zero findings from a rule whose query is silently erroring is not posture,
    // it's a blind spot (spec 030's whole reason for existing).
    const failingRuleIds = new Set(rows.map(f => f.ruleId).filter(id => stateRuleIds.has(id)));
    let passingRules = 0;
    let unknownRules = 0;
    for (const id of stateRuleIds) {
      if (failingRuleIds.has(id)) continue;
      if (ruleById.get(id)?.lastRunStatus === 'success') passingRules++;
      else unknownRules++;
    }
    const posturePct = totalRules === 0 ? null : Math.round((passingRules / totalRules) * 100);

    await run(db.insert(snapshotsTable).values({
      category: categoryId,
      subscriptionId,
      date,
      posturePct,
      passingRules,
      totalRules,
      unknownRules,
      activityRuleCount,
      formulaVersion: SNAPSHOT_FORMULA_VERSION,
      activeFindings: rows.length,
      severityCounts: JSON.stringify(severityCounts),
      updatedAt,
    }).onConflictDoUpdate({
      target: [snapshotsTable.category, snapshotsTable.subscriptionId, snapshotsTable.date],
      set: { posturePct, passingRules, totalRules, unknownRules, activityRuleCount, formulaVersion: SNAPSHOT_FORMULA_VERSION, activeFindings: rows.length, severityCounts: JSON.stringify(severityCounts), updatedAt },
    }));
  }

  await upsertRow('', visible);

  const subIds = new Set(visible.map(f => f.subscriptionId).filter(Boolean));
  for (const subId of subIds) {
    await upsertRow(subId, visible.filter(f => f.subscriptionId === subId));
  }

  const cutoff = toDateKey(new Date(now.getTime() - RETENTION_DAYS * 86_400_000));
  await run(db.delete(snapshotsTable).where(lt(snapshotsTable.date, cutoff)));
}

/** `subscriptionId` omitted (or '') queries the aggregate (all-subscriptions) row. The only
 *  granularity that existed before Phase 5. Pass a specific subscription id to get that
 *  subscription's own trend history instead.
 *
 *  Anyone who does not hold Everything is never given the aggregate row, which counts every finding
 *  on the install, and gets a subscription's row only for one they hold whole (#274). A resource
 *  group Scope holds no whole subscription, so it reads nothing here. */
export async function getSnapshots(access: Access, opts: { categories?: string[]; subscriptionId?: string; sinceDate?: string } = {}): Promise<DailySnapshot[]> {
  const subscription = subscriptionCondition(access, opts.subscriptionId);
  if (!subscription) return [];
  const conditions = [subscription];
  if (opts.categories && opts.categories.length > 0) conditions.push(inArray(snapshotsTable.category, opts.categories));
  if (opts.sinceDate) conditions.push(gte(snapshotsTable.date, opts.sinceDate));

  const rows = await many(db.select().from(snapshotsTable).where(and(...conditions)).orderBy(snapshotsTable.date));

  return rows.map(rowToSnapshot);
}

/** The condition on a snapshot's subscription for one person, or null when they may read none of it.
 *  Everything reads exactly what it asked for. Anyone else reads a subscription held whole, compared
 *  without regard to case, and never the aggregate. */
function subscriptionCondition(access: Access, subscriptionId: string | undefined): SQL | null {
  if (access.everything) return eq(snapshotsTable.subscriptionId, subscriptionId ?? '');
  if (!subscriptionId || !wholeSubscriptionIds(access).includes(subscriptionId.toLowerCase())) return null;
  return sql`lower(${snapshotsTable.subscriptionId}) = ${subscriptionId.toLowerCase()}`;
}

/** Latest row per category on or before `onOrBefore`: used as the delta baseline. Defaults to
 *  the aggregate (all-subscriptions) row; pass `subscriptionId` for a per-subscription baseline.
 *  Narrowed like `getSnapshots`. */
export async function getBaselineSnapshots(categories: string[], onOrBefore: string, access: Access, subscriptionId?: string): Promise<DailySnapshot[]> {
  if (categories.length === 0) return [];
  const subscription = subscriptionCondition(access, subscriptionId);
  if (!subscription) return [];
  const rows = await many(db.select().from(snapshotsTable)
    .where(and(
      inArray(snapshotsTable.category, categories),
      subscription,
      lte(snapshotsTable.date, onOrBefore),
    ))
    .orderBy(desc(snapshotsTable.date)));

  const seen = new Set<string>();
  const out: DailySnapshot[] = [];
  for (const row of rows) {
    if (seen.has(row.category)) continue;
    seen.add(row.category);
    out.push(rowToSnapshot(row));
  }
  return out;
}

/** When each category's install-wide snapshot was last written, on or before `onOrBefore`. Only the
 *  time: a time is the same for everyone and carries no count, so a person on less than Everything
 *  can be told when a category was last scanned without being handed an aggregate number. */
export async function getLastSnapshotTimes(categories: string[], onOrBefore: string): Promise<Map<string, string>> {
  const times = new Map<string, string>();
  if (categories.length === 0) return times;
  const rows = await many(db.select({ category: snapshotsTable.category, updatedAt: snapshotsTable.updatedAt })
    .from(snapshotsTable)
    .where(and(
      inArray(snapshotsTable.category, categories),
      eq(snapshotsTable.subscriptionId, ''),
      lte(snapshotsTable.date, onOrBefore),
    ))
    .orderBy(desc(snapshotsTable.date)));
  for (const row of rows) if (!times.has(row.category)) times.set(row.category, row.updatedAt);
  return times;
}

// --- one-time backfill from existing scan-blob history ---

/** Approximates historical daily snapshots from the scan-blob history (last scan of each day
 *  wins) so trend charts aren't empty on upgrade. Then writes an accurate "today" row for every
 *  category from the live findings table, which supersedes the blob-derived approximation. */
export async function backfillSnapshots(): Promise<void> {
  if (await getMeta(SNAPSHOTS_BACKFILL_MARKER)) return;

  const categories = await listCategories();
  for (const category of categories) {
    const history = await loadStoredScanBlobs(category.id, SYSTEM_ACCESS); // newest-first
    if (history.length === 0) continue;

    const byDay = new Map<string, (typeof history)[number]>();
    for (const scan of history) {
      const day = scan.finishedAt.slice(0, 10);
      const existing = byDay.get(day);
      if (!existing || scan.finishedAt > existing.finishedAt) byDay.set(day, scan);
    }

    for (const [day, scan] of byDay) {
      if (scan.totalRules === 0) continue;
      const failingIds = new Set(scan.findings.map(f => f.ruleId));
      const passing = scan.totalRules - failingIds.size;
      const severityCounts = emptySeverityCounts();
      for (const f of scan.findings) {
        const sev = f.severity as Severity;
        if (sev in severityCounts) severityCounts[sev]++;
      }
      await run(db.insert(snapshotsTable).values({
        category: category.id,
        subscriptionId: '',
        date: day,
        posturePct: Math.round((passing / scan.totalRules) * 100),
        passingRules: passing,
        totalRules: scan.totalRules,
        // Explicit rather than relying on the schema default: this is the pre-spec-030 formula
        // (no unknownRules distinction, no lastRunStatus check), so it must never be mistaken for
        // an honest row even if the default changes later.
        formulaVersion: SNAPSHOT_FORMULA_VERSION,
        activeFindings: scan.findings.length,
        severityCounts: JSON.stringify(severityCounts),
        updatedAt: scan.finishedAt,
      }).onConflictDoNothing());
    }
  }

  // Write an accurate "today" row for every category from live state: supersedes any
  // blob-derived approximation for today specifically.
  for (const category of categories) {
    await upsertDailySnapshot(category.id);
  }

  await setMeta(SNAPSHOTS_BACKFILL_MARKER, '1');
}
