import { listFindings, getFindingEventCounts, getActivityOccurrenceCounts, type FindingRecord } from './db/findings';
import { loadRules } from './rules';
import { listCategories } from './db/categories';
import { loadSuppressions, isActiveSuppression } from './suppressions';
import { getSnapshots, getBaselineSnapshots, SNAPSHOT_FORMULA_VERSION, type DailySnapshot } from './db/snapshots';
import { resolveDateWindow } from './date-window';
import { listScanMetas } from './scan-history';
import type { WidgetFilters } from './dashboard-filters';
import type { Category, IncompleteRule, Rule, Severity } from './types';
import { emptySeverityCounts } from './severity';

/** `from`/`to` are date keys (YYYY-MM-DD), inclusive — no `Date.now()` dependency, so this works
 *  identically for a rolling "last N days" window and a fixed past calendar range alike. */
function isWithinRange(iso: string | undefined, from: string, to: string): boolean {
  if (!iso) return false;
  const day = iso.slice(0, 10);
  return day >= from && day <= to;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Mirrors the enabled-rule-set logic in db/snapshots.ts's upsertDailySnapshot. Only 'state' rules
 *  count toward the posture score — 'activity' rules (spec 030) have no meaningful "zero
 *  findings means passing" state, so they're split out as a count rather than folded into either
 *  side of the score.
 *
 *  `filters.severities`/`filters.tags` narrow the denominator the same way `matchesFilters` already
 *  narrows the numerator (spec 039 / RB-RM-015) — a widget scoped to "high severity" should count
 *  only high-severity rules as "in scope", not the whole category. `resourceGroups`/`subscriptions`
 *  are deliberately NOT applied here: neither is a property of a `Rule`, so narrowing by them would
 *  need real per-subscription/RG resource-type applicability (out of scope, see spec 039 §2). */
function enabledRuleIdsForCategory(
  category: Category,
  allRules: Rule[],
  filters?: Pick<WidgetFilters, 'severities' | 'tags'>,
): { stateRuleIds: Set<string>; activityRuleCount: number } {
  let enabled = allRules.filter(r => r.enabled && r.category === category.id);
  if (filters?.severities?.length) {
    enabled = enabled.filter(r => filters.severities!.includes(r.severity));
  }
  if (filters?.tags?.length) {
    enabled = enabled.filter(r => (r.tags ?? []).some(t => filters.tags!.includes(t)));
  }
  const stateRuleIds = new Set(enabled.filter(r => (r.kind ?? 'state') === 'state').map(r => r.id));
  return { stateRuleIds, activityRuleCount: enabled.length - stateRuleIds.size };
}

/** Splits a scope's rule ids by outcome against its findings: passing (zero findings, proven
 *  success), or unknown (zero findings but not a proven success — including never run). A rule
 *  with an active finding is skipped — it's implicitly failing, and never 'unknown' even if its
 *  last run technically errored, since the finding is real even if not exhaustive (spec 004's
 *  capped/failed distinction). */
function splitRuleOutcomes(ruleIds: Set<string>, findings: FindingRecord[], ruleById: Map<string, Rule>): { passing: number; unknown: number } {
  const failingIds = new Set(findings.map(f => f.ruleId).filter(id => ruleIds.has(id)));
  let passing = 0;
  let unknown = 0;
  for (const id of ruleIds) {
    if (failingIds.has(id)) continue;
    if (ruleById.get(id)?.lastRunStatus === 'success') passing++;
    else unknown++;
  }
  return { passing, unknown };
}

function matchesFilters(
  f: FindingRecord,
  filters: WidgetFilters,
  ruleById: Map<string, Rule>,
  suppressedFingerprints: Set<string>,
): boolean {
  if (suppressedFingerprints.has(f.fingerprint)) return false;
  if (filters.categories?.length && !filters.categories.includes(f.category)) return false;
  if (filters.subscriptions?.length && !filters.subscriptions.includes(f.subscriptionId)) return false;
  if (filters.resourceGroups?.length && (!f.resourceGroup || !filters.resourceGroups.includes(f.resourceGroup))) return false;
  if (filters.severities?.length && !filters.severities.includes(f.severity)) return false;
  if (filters.ruleIds?.length && !filters.ruleIds.includes(f.ruleId)) return false;
  if (filters.tags?.length) {
    const ruleTags = ruleById.get(f.ruleId)?.tags ?? [];
    if (!filters.tags.some(t => ruleTags.includes(t))) return false;
  }
  return true;
}

async function suppressedFingerprintSet(filters: WidgetFilters): Promise<Set<string>> {
  if (filters.includeSuppressed) return new Set();
  return new Set((await loadSuppressions()).filter(isActiveSuppression).map(s => s.fingerprint));
}

/** Active findings matching every dimension in `filters`. Excludes actively-suppressed
 *  fingerprints unless `filters.includeSuppressed`. */
export async function queryActiveFindings(filters: WidgetFilters): Promise<FindingRecord[]> {
  const all = await listFindings({ status: 'active' });
  const ruleById = new Map((await loadRules()).map(r => [r.id, r]));
  const suppressed = await suppressedFingerprintSet(filters);
  return all.filter(f => matchesFilters(f, filters, ruleById, suppressed));
}

async function queryFixedFindings(filters: WidgetFilters): Promise<FindingRecord[]> {
  const all = await listFindings({ status: 'fixed' });
  const ruleById = new Map((await loadRules()).map(r => [r.id, r]));
  const suppressed = await suppressedFingerprintSet(filters);
  return all.filter(f => matchesFilters(f, filters, ruleById, suppressed));
}

function aggregateSnapshotsByDate(snaps: DailySnapshot[]): Array<{ date: string; pct: number | null; findings: number; passing: number; total: number }> {
  const byDate = new Map<string, { passing: number; total: number; findings: number }>();
  for (const s of snaps) {
    const e = byDate.get(s.date) ?? { passing: 0, total: 0, findings: 0 };
    e.passing += s.passingRules;
    e.total += s.totalRules;
    e.findings += s.activeFindings;
    byDate.set(s.date, e);
  }
  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, e]) => ({
      date,
      pct: e.total === 0 ? null : Math.round((e.passing / e.total) * 100),
      findings: e.findings,
      passing: e.passing,
      total: e.total,
    }));
}

function groupSnapshotsByCategory(snaps: DailySnapshot[]): Record<string, Array<{ date: string; pct: number | null; findings: number; passing: number; total: number }>> {
  const map: Record<string, Array<{ date: string; pct: number | null; findings: number; passing: number; total: number }>> = {};
  for (const s of snaps) {
    (map[s.category] ??= []).push({ date: s.date, pct: s.posturePct, findings: s.activeFindings, passing: s.passingRules, total: s.totalRules });
  }
  for (const key of Object.keys(map)) map[key].sort((a, b) => a.date.localeCompare(b.date));
  return map;
}

export interface WidgetSummary {
  // --- live, findings-sourced: computed from the `findings` lifecycle table (+ `finding_events`
  //     for newVsFixedTrend). Exact and available under every filter combination. Any number here
  //     that's also shown on the Scans page must reuse its predicate (getRecencyStatus). ---
  current: {
    pct: number | null;
    passingRules: number;
    totalRules: number;
    /** Zero active findings but the rule's last run wasn't a proven success (or it has never run)
     *  — neither passing nor failing (spec 030). Never folded into passingRules or totalRules. */
    unknownRules: number;
    /** 'activity'-kind rules in scope, excluded from totalRules/passingRules entirely — they can
     *  never be scored the same way (no meaningful "zero findings" passing state). */
    activityRuleCount: number;
    activeFindings: number;
    severityCounts: Record<Severity, number>;
    newInWindow: number;
    fixedInWindow: number;
  };
  /** Whether actively-suppressed findings were counted in the numbers above (spec 039 /
   *  RB-RM-016) — mirrors `filters.includeSuppressed ?? false`. No dashboard control can set this
   *  true yet (no widget exposes the toggle), but the response is self-describing the moment one
   *  does, rather than requiring every future consumer to separately track which mode it asked for. */
  suppressedIncluded: boolean;
  /** Net lifecycle change over the window (newInWindow − fixedInWindow) — a count, not a level
   *  comparison against a past snapshot. See DATA-SOURCE-UNIFICATION-PLAN.md §3. */
  deltaFindings: number | null;
  perCategory: Array<{
    category: string; label: string; color?: string; pct: number | null; activeFindings: number;
    /** Same passing/total the pct is rounded from — the honest headline (spec 033), with pct as
     *  the secondary, rounded figure. */
    passing: number; total: number;
    lastScanAt: string | null;
    /** From the category's most recent scan row — null when it has never been scanned. A category
     *  can be 'fresh' by timestamp and still 'partial': the scan ran recently but a rule failed or
     *  was capped, so its posture % may not reflect reality (spec 004). */
    lastScanCoverage: 'complete' | 'partial' | null;
    lastScanIncompleteRules: IncompleteRule[];
  }>;
  /** Per-subscription posture, derived live from findings (no schema change) — only subscriptions
   *  with at least one active finding appear (there's no tenant-wide subscription list without a
   *  live ARM call), sorted worst-posture-first. `pct`/`totalRules` mirror the per-category
   *  calc: rules with zero violations in that subscription / rules in scope for the active
   *  category+rule filters. */
  perSubscription: Array<{ subscriptionId: string; pct: number | null; activeFindings: number; totalRules: number; passingRules: number }>;
  /** Daily created-vs-resolved counts for the New vs Fixed widget — available under every filter
   *  combination (subscription/RG/severity via a fingerprint join to `findings`, tags resolved to
   *  rule ids), unlike the snapshot-sourced `trend`. */
  newVsFixedTrend: Array<{ date: string; created: number; resolved: number }>;
  /** Daily occurrence counts for kind:'activity' findings — the Activity Occurrences widget's
   *  data source (spec 034). Same filter support as newVsFixedTrend (subscription/RG/severity via
   *  a fingerprint join, tags resolved to rule ids). Empty when nothing in scope is activity-kind
   *  — the widget renders its own empty state for that, it isn't an error. */
  activityTrend: Array<{ date: string; count: number }>;
  lastScanAt: string | null;

  // --- historical, snapshot-sourced: computed from `posture_snapshots`, needed because a past
  //     percentage requires the past denominator (rules enabled / resources in scope at that
  //     time), which live findings can't reconstruct. Null under filters snapshots can't
  //     represent — see `trendIsCategoryScopedOnly`. ---
  /** `date` is the oldest per-category baseline row's date actually reached (categories can each
   *  land on a different snapshot date) — always show this, not an assumed "N days ago". */
  baseline: { pct: number | null; date: string } | null;
  deltaPct: number | null;
  trend: Array<{ date: string; pct: number | null; findings: number; passing: number; total: number }>;
  trendByCategory?: Record<string, Array<{ date: string; pct: number | null; findings: number; passing: number; total: number }>>;
  /** True when `trend`/`baseline`/`deltaPct` are unavailable for the active filters — i.e.
   *  anything beyond category + at most one subscription (RG/tag/severity/rule, or more than one
   *  subscription at once). `deltaFindings` is findings-sourced and stays available regardless.
   *  Name kept from pre-Phase-5 for call-site stability. */
  trendIsCategoryScopedOnly: boolean;
}

/** Live posture/findings numbers from the findings lifecycle table, plus trend/baseline
 *  history from posture_snapshots (meaningful when `filters` narrows to category and/or a
 *  single subscription — snapshots are recorded per category × subscription (Phase 5); any
 *  RG/tag/severity/rule filter, or more than one subscription at once, makes "trend over time"
 *  ill-defined at that granularity since it isn't recorded). */
export async function computeWidgetSummary(filters: WidgetFilters, trendDays: number): Promise<WidgetSummary> {
  const { from, to } = resolveDateWindow(filters.dateWindow);
  const allCategories = await listCategories();
  const allRules = await loadRules();
  const ruleById = new Map(allRules.map(r => [r.id, r]));
  const targetCategories = filters.categories?.length
    ? allCategories.filter(c => filters.categories!.includes(c.id))
    : allCategories;

  const activeFindings = await queryActiveFindings(filters);

  const severityCounts = emptySeverityCounts();
  for (const f of activeFindings) {
    if (f.severity in severityCounts) severityCounts[f.severity]++;
  }

  let totalRules: number;
  let passingRules: number;
  let unknownRules: number;
  let activityRuleCount: number;
  let scopedRuleIds: Set<string>;

  if (filters.ruleIds?.length) {
    // Rule-scoped widget (replaces the old policy-data route): pct is selected-rules
    // passing/total, computed live — rule-level history isn't tracked in posture_snapshots.
    // An explicitly-selected activity rule still can't be scored the same way as a state rule
    // (spec 030), so it's excluded from totalRules here too, not just in the category-wide branch.
    const stateSelected = filters.ruleIds.filter(id => (ruleById.get(id)?.kind ?? 'state') === 'state');
    scopedRuleIds = new Set(stateSelected);
    totalRules = scopedRuleIds.size;
    activityRuleCount = filters.ruleIds.length - stateSelected.length;
    const outcome = splitRuleOutcomes(scopedRuleIds, activeFindings, ruleById);
    passingRules = outcome.passing;
    unknownRules = outcome.unknown;
  } else {
    scopedRuleIds = new Set();
    let total = 0;
    let passing = 0;
    let unknown = 0;
    let activity = 0;
    for (const cat of targetCategories) {
      const { stateRuleIds, activityRuleCount: catActivity } = enabledRuleIdsForCategory(cat, allRules, filters);
      for (const id of stateRuleIds) scopedRuleIds.add(id);
      total += stateRuleIds.size;
      activity += catActivity;
      const catFindings = activeFindings.filter(f => f.category === cat.id);
      const outcome = splitRuleOutcomes(stateRuleIds, catFindings, ruleById);
      passing += outcome.passing;
      unknown += outcome.unknown;
    }
    totalRules = total;
    passingRules = passing;
    unknownRules = unknown;
    activityRuleCount = activity;
  }

  const pct = totalRules === 0 ? null : Math.round((passingRules / totalRules) * 100);

  const newInWindow = activeFindings.filter(f => isWithinRange(f.firstSeenAt, from, to)).length;
  const fixedFindings = await queryFixedFindings(filters);
  const fixedInWindow = fixedFindings.filter(f => isWithinRange(f.resolvedAt, from, to)).length;

  // Findings-sourced, not snapshot-sourced: net lifecycle change over the window, using the same
  // firstSeenAt/resolvedAt predicate as Scans' getRecencyStatus, so this always agrees with the
  // Scans page and works under every filter (unlike deltaPct/baseline, which need a snapshot).
  const deltaFindings = newInWindow - fixedInWindow;

  // Latest snapshot row per target category — used both for per-category lastScanAt and the
  // overall lastScanAt below. A category with no snapshot row yet has never been scanned.
  const categoryIds = targetCategories.map(c => c.id);
  const latestSnapshots = await getBaselineSnapshots(categoryIds, today());
  const latestByCategory = new Map(latestSnapshots.map(s => [s.category, s]));

  const perCategory = await Promise.all(targetCategories.map(async cat => {
    const { stateRuleIds } = enabledRuleIdsForCategory(cat, allRules, filters);
    const catTotal = stateRuleIds.size;
    const catFindings = activeFindings.filter(f => f.category === cat.id);
    const { passing: catPassing } = splitRuleOutcomes(stateRuleIds, catFindings, ruleById);
    const catPct = catTotal === 0 ? null : Math.round((catPassing / catTotal) * 100);
    // A high posture % is misleading if the scan behind it didn't finish — the coverage-freshness
    // widget must show that alongside recency, not just "how long ago" (spec 004).
    const [lastScan] = await listScanMetas(cat.id, 1);
    return {
      category: cat.id,
      label: cat.label,
      color: cat.color,
      pct: catPct,
      activeFindings: catFindings.length,
      passing: catPassing,
      total: catTotal,
      lastScanAt: latestByCategory.get(cat.id)?.updatedAt ?? null,
      lastScanCoverage: lastScan?.coverage ?? null,
      lastScanIncompleteRules: lastScan?.incompleteRules ?? [],
    };
  }));

  const lastScanAt = perCategory.reduce<string | null>((max, m) => {
    if (!m.lastScanAt) return max;
    return !max || m.lastScanAt > max ? m.lastScanAt : max;
  }, null);

  const current: WidgetSummary['current'] = {
    pct, passingRules, totalRules, unknownRules, activityRuleCount,
    activeFindings: activeFindings.length,
    severityCounts, newInWindow, fixedInWindow,
  };
  const suppressedIncluded = filters.includeSuppressed ?? false;

  // Only subscriptions with at least one active finding are knowable without a live ARM call —
  // see WidgetSummary's perSubscription doc comment.
  const subIds = Array.from(new Set(activeFindings.map(f => f.subscriptionId).filter(Boolean)));
  const perSubscription = subIds.map(subId => {
    const subFindings = activeFindings.filter(f => f.subscriptionId === subId);
    const total = scopedRuleIds.size;
    const { passing } = splitRuleOutcomes(scopedRuleIds, subFindings, ruleById);
    return {
      subscriptionId: subId,
      pct: total === 0 ? null : Math.round((passing / total) * 100),
      activeFindings: subFindings.length,
      totalRules: total,
      passingRules: passing,
    };
  }).sort((a, b) => (a.pct ?? 101) - (b.pct ?? 101) || b.activeFindings - a.activeFindings);

  // New vs Fixed supports every filter dimension: subscription/RG/severity via a join to the
  // findings row (see getFindingEventCounts), tags resolved here to rule ids (rules own tags,
  // same predicate as matchesFilters). An empty tag∩rule intersection must yield zero events,
  // not "no filter" — hence the impossible-id sentinel.
  let eventRuleIds = filters.ruleIds;
  if (filters.tags?.length) {
    const tagRuleIds = allRules
      .filter(r => (r.tags ?? []).some(t => filters.tags!.includes(t)))
      .map(r => r.id);
    eventRuleIds = eventRuleIds?.length ? eventRuleIds.filter(id => tagRuleIds.includes(id)) : tagRuleIds;
    if (eventRuleIds.length === 0) eventRuleIds = ['__no-matching-rule__'];
  }
  const eventCategoryIds = filters.categories?.length ? filters.categories : allCategories.map(c => c.id);
  const newVsFixedTrend = await getFindingEventCounts({
    categories: eventCategoryIds,
    ruleIds: eventRuleIds,
    subscriptions: filters.subscriptions,
    resourceGroups: filters.resourceGroups,
    severities: filters.severities,
    sinceDate: daysAgo(trendDays),
  });
  const activityTrend = await getActivityOccurrenceCounts({
    categories: eventCategoryIds,
    ruleIds: eventRuleIds,
    subscriptions: filters.subscriptions,
    resourceGroups: filters.resourceGroups,
    severities: filters.severities,
    sinceDate: daysAgo(trendDays),
  });

  // Trend/baseline need a representation in posture_snapshots. Category is always supported
  // (snapshots are recorded per category). A *single* subscription is also supported — snapshots
  // now carry a per-subscription breakdown (Phase 5) — but RG/tag/severity/rule filters aren't
  // recorded at all, and combining more than one subscription can't be reconstructed from summed
  // per-subscription totals (each rule's pass/fail would need to be evaluated across the union of
  // subscriptions, which isn't recoverable from the stored per-day counts).
  const hasUnsupportedTrendFilter = Boolean(
    filters.resourceGroups?.length || filters.tags?.length ||
    filters.severities?.length || filters.ruleIds?.length ||
    (filters.subscriptions && filters.subscriptions.length > 1),
  );

  if (hasUnsupportedTrendFilter) {
    return {
      current, suppressedIncluded, baseline: null, deltaPct: null, deltaFindings,
      perCategory, perSubscription, trend: [], newVsFixedTrend, activityTrend, lastScanAt, trendIsCategoryScopedOnly: true,
    };
  }

  const trendCategoryIds = filters.categories?.length ? filters.categories : allCategories.map(c => c.id);
  const trendSubscriptionId = filters.subscriptions?.length === 1 ? filters.subscriptions[0] : undefined;
  const snaps = await getSnapshots({ categories: trendCategoryIds, subscriptionId: trendSubscriptionId, sinceDate: daysAgo(trendDays) });
  const trend = aggregateSnapshotsByDate(snaps);
  const trendByCategory = groupSnapshotsByCategory(snaps);

  // Only compare against baseline rows written under the same formula this scope's live `pct` is
  // computed under — otherwise a category whose baseline predates spec 030 (or was backfilled)
  // gets blended in as if it were an honest number, producing a delta that doesn't mean anything
  // (the "-75% vs baseline" bug). A category with no honest baseline yet is excluded from the
  // blend entirely rather than blanking the whole widget; it reappears once enough days of
  // honest-formula snapshots accumulate.
  const honestBaselineSnaps = (await getBaselineSnapshots(trendCategoryIds, from, trendSubscriptionId))
    .filter(s => s.formulaVersion === SNAPSHOT_FORMULA_VERSION);
  let baseline: WidgetSummary['baseline'] = null;
  let deltaPct: number | null = null;
  if (honestBaselineSnaps.length > 0) {
    const baselineSnaps = honestBaselineSnaps;
    const baselinePassing = baselineSnaps.reduce((s, x) => s + x.passingRules, 0);
    const baselineTotal = baselineSnaps.reduce((s, x) => s + x.totalRules, 0);
    const basePct = baselineTotal === 0 ? null : Math.round((baselinePassing / baselineTotal) * 100);
    // Categories can each land on a different snapshot date (missed scans, backfill drift) — the
    // oldest is the honest bound for "how far back does this comparison actually reach".
    const oldestDate = baselineSnaps.reduce((min, x) => (x.date < min ? x.date : min), baselineSnaps[0].date);
    baseline = { pct: basePct, date: oldestDate };
    deltaPct = (pct !== null && basePct !== null) ? pct - basePct : null;
  }

  return {
    current, suppressedIncluded, baseline, deltaPct, deltaFindings,
    perCategory, perSubscription, trend, trendByCategory, newVsFixedTrend, activityTrend, lastScanAt,
    trendIsCategoryScopedOnly: false,
  };
}
