import { eq, and, inArray, gte, lte, lt, desc } from 'drizzle-orm';
import { db } from './client';
import { postureSnapshots as snapshotsTable, findings as findingsTable } from './schema';
import { getCategory, listCategories } from './categories';
import { loadRules } from '../rules';
import { loadSuppressions, isActiveSuppression } from '../suppressions';
import { loadScanHistory } from '../scan-history';
import { getMetaSync as getMeta, setMetaSync as setMeta } from './meta'; // sync SQLite-only until #73 Phase 2
import { emptySeverityCounts } from '../severity';
import type { Severity } from '../types';

const RETENTION_DAYS = 365;
const BACKFILL_MARKER = 'snapshots-backfilled-v1';

/** The posture formula a freshly-written row is computed under — bump this whenever the
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
  /** Zero findings but the rule's last real run wasn't a proven success (or it never ran) —
   *  neither passing nor failing (spec 030). 0 on every row written before this column existed,
   *  meaning "not distinguished then", not "genuinely none". */
  unknownRules: number;
  /** 'activity'-kind rules enabled for this category, excluded from totalRules entirely — they
   *  can never be scored the same way (no meaningful "zero findings" passing state). */
  activityRuleCount: number;
  /** Which posture formula computed this row's pct/passingRules/totalRules — see
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

/** Recomputes and upserts today's (UTC) row(s) for a category from the live findings table — an
 *  aggregate row (subscriptionId '') plus one row per subscription that currently has an active
 *  finding in this category (same "only knowable via live findings" limitation as
 *  dashboard-data.ts's `perSubscription`: a subscription that reaches zero findings simply stops
 *  getting a fresh row rather than writing an explicit 100%/0-findings row). */
export function upsertDailySnapshot(categoryId: string, now: Date = new Date()): void {
  const category = getCategory(categoryId);
  if (!category) return;

  const enabledRules = loadRules().filter(r => r.enabled && r.category === categoryId);
  const stateRules = enabledRules.filter(r => (r.kind ?? 'state') === 'state');
  const stateRuleIds = new Set(stateRules.map(r => r.id));
  const ruleById = new Map(enabledRules.map(r => [r.id, r]));
  const totalRules = stateRules.length;
  const activityRuleCount = enabledRules.length - stateRules.length;

  const activeRows = db.select().from(findingsTable)
    .where(and(eq(findingsTable.category, categoryId), eq(findingsTable.status, 'active')))
    .all();

  const suppressedFingerprints = new Set(
    loadSuppressions().filter(isActiveSuppression).map(s => s.fingerprint),
  );
  const visible = activeRows.filter(f => !suppressedFingerprints.has(f.fingerprint));

  const date = toDateKey(now);
  const updatedAt = now.toISOString();

  function upsertRow(subscriptionId: string, rows: typeof visible): void {
    const severityCounts = emptySeverityCounts();
    for (const f of rows) {
      const sev = f.severity as Severity;
      if (sev in severityCounts) severityCounts[sev]++;
    }

    // A rule only counts as passing if it has zero findings here AND its last real run actually
    // succeeded — zero findings from a rule whose query is silently erroring is not posture,
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

    db.insert(snapshotsTable).values({
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
    }).run();
  }

  upsertRow('', visible);

  const subIds = new Set(visible.map(f => f.subscriptionId).filter(Boolean));
  for (const subId of subIds) {
    upsertRow(subId, visible.filter(f => f.subscriptionId === subId));
  }

  const cutoff = toDateKey(new Date(now.getTime() - RETENTION_DAYS * 86_400_000));
  db.delete(snapshotsTable).where(lt(snapshotsTable.date, cutoff)).run();
}

/** `subscriptionId` omitted (or '') queries the aggregate (all-subscriptions) row — the only
 *  granularity that existed before Phase 5. Pass a specific subscription id to get that
 *  subscription's own trend history instead. */
export function getSnapshots(opts: { categories?: string[]; subscriptionId?: string; sinceDate?: string } = {}): DailySnapshot[] {
  const conditions = [eq(snapshotsTable.subscriptionId, opts.subscriptionId ?? '')];
  if (opts.categories && opts.categories.length > 0) conditions.push(inArray(snapshotsTable.category, opts.categories));
  if (opts.sinceDate) conditions.push(gte(snapshotsTable.date, opts.sinceDate));

  const rows = db.select().from(snapshotsTable).where(and(...conditions)).orderBy(snapshotsTable.date).all();

  return rows.map(rowToSnapshot);
}

/** Latest row per category on or before `onOrBefore` — used as the delta baseline. Defaults to
 *  the aggregate (all-subscriptions) row; pass `subscriptionId` for a per-subscription baseline. */
export function getBaselineSnapshots(categories: string[], onOrBefore: string, subscriptionId?: string): DailySnapshot[] {
  if (categories.length === 0) return [];
  const rows = db.select().from(snapshotsTable)
    .where(and(
      inArray(snapshotsTable.category, categories),
      eq(snapshotsTable.subscriptionId, subscriptionId ?? ''),
      lte(snapshotsTable.date, onOrBefore),
    ))
    .orderBy(desc(snapshotsTable.date))
    .all();

  const seen = new Set<string>();
  const out: DailySnapshot[] = [];
  for (const row of rows) {
    if (seen.has(row.category)) continue;
    seen.add(row.category);
    out.push(rowToSnapshot(row));
  }
  return out;
}

// --- one-time backfill from existing scan-blob history ---

/** Approximates historical daily snapshots from the scan-blob history (last scan of each day
 *  wins) so trend charts aren't empty on upgrade. Then writes an accurate "today" row for every
 *  category from the live findings table, which supersedes the blob-derived approximation. */
export function backfillSnapshots(): void {
  if (getMeta(BACKFILL_MARKER)) return;

  const categories = listCategories();
  for (const category of categories) {
    const history = loadScanHistory(category.id); // newest-first
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
      db.insert(snapshotsTable).values({
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
      }).onConflictDoNothing().run();
    }
  }

  // Write an accurate "today" row for every category from live state — supersedes any
  // blob-derived approximation for today specifically.
  for (const category of categories) {
    upsertDailySnapshot(category.id);
  }

  setMeta(BACKFILL_MARKER, '1');
}
