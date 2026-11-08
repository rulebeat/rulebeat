import { listFindings, listFindingSummaries, getFindingEventCounts, getActivityOccurrenceCounts, type FindingRecord, type FindingSummary } from './db/findings';
import { loadRules } from './rules';
import { listCategories } from './db/categories';
import { loadSuppressions, isActiveSuppression } from './suppressions';
import { getSnapshots, getBaselineSnapshots, getFirstSnapshotDates, type DailySnapshot } from './db/snapshots';
import { posturePct, postureDelta } from './posture-math';
import { equalFormulaVersions } from './trend-version-equality';
import type { BaselineGap } from './posture-baseline';
import { trendScopeOf, type TrendReason } from './trend-scope';
import { resolveDateWindow } from './date-window';
import { listLastScanTimes } from './scan-history';
import type { WidgetFilters } from './dashboard-filters';
import type { Category, Rule, Severity } from './types';
import { emptySeverityCounts } from './severity';
import { DIRECTORY_SUBSCRIPTION, subscriptionValue } from './placement';
import { countsTowardPosture, countsInFindingTotals, isActivityRule } from './finding-kinds';
import { accessReach, type Access } from './access-model';
import { listHierarchyNodes } from './db/management-group-hierarchy';
import type { HierarchyNode } from './management-group-tree';
import { incompleteRulesOf, narrowScopes, ruleOverlapsScopes } from './rule-overlap';

/** `from`/`to` are date keys (YYYY-MM-DD), inclusive. No `Date.now()` dependency, so this works
 *  identically for a rolling "last N days" window and a fixed past calendar range alike. */
function isWithinRange(iso: string | undefined, from: string, to: string): boolean {
  if (!iso) return false;
  const day = iso.slice(0, 10);
  return day >= from && day <= to;
}

function dayBefore(dateKey: string): string {
  return new Date(new Date(`${dateKey}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** The Scopes the live posture is read over (formula v3): the viewer's Access intersected with the
 *  subscription filter. A resource group filter names groups by name only, so it narrows through the
 *  subscriptions those groups are known to sit in: any finding the viewer can see, of any status or
 *  kind, suppressed or not, and the groups they hold. A group no subscription is known for narrows
 *  nothing, so every rule that looks at the viewer's Scopes still counts for it. */
async function postureScopes(filters: WidgetFilters, access: Access): Promise<Access> {
  let subscriptions = filters.subscriptions?.length ? filters.subscriptions : undefined;
  if (filters.resourceGroups?.length) {
    const wanted = new Set(filters.resourceGroups.map(g => g.toLowerCase()));
    const known = new Set<string>();
    for (const f of await listFindingSummaries(access)) {
      if (f.resourceGroup && wanted.has(f.resourceGroup.toLowerCase())) known.add(f.subscriptionId.toLowerCase());
    }
    for (const [sub, groups] of accessReach(access).resourceGroups) {
      if ([...groups].some(g => wanted.has(g.toLowerCase()))) known.add(sub.toLowerCase());
    }
    if (known.size > 0) subscriptions = (subscriptions ?? [...known]).filter(s => known.has(s.toLowerCase()));
  }
  return narrowScopes(access, subscriptions);
}

/** The enabled rules of a category that match the rule-level filters (rule ids and the rule's own
 *  tags). A Severity filter is not one: it decides which findings make a rule fail, not which rules
 *  are counted. `resourceGroups`/`subscriptions` act through the Scopes instead, because neither is a
 *  property of a `Rule`. A rule id missing from the rule list matches nothing. */
function enabledRulesOfCategory(category: Category, allRules: Rule[], filters: Pick<WidgetFilters, 'tags' | 'ruleIds'>): Rule[] {
  let enabled = allRules.filter(r => r.enabled && r.category === category.id);
  if (filters.ruleIds?.length) enabled = enabled.filter(r => filters.ruleIds!.includes(r.id));
  if (filters.tags?.length) enabled = enabled.filter(r => (r.tags ?? []).some(t => filters.tags!.includes(t)));
  return enabled;
}

/** The rules posture counts for a category: enabled Problem rules that match the rule-level filters
 *  and whose own scope overlaps the Scopes. 'activity' rules (spec 030) have no meaningful "zero
 *  findings means passing" state, so they are split out as a count rather than folded into either
 *  side of the score. */
function countedRulesForCategory(
  category: Category, allRules: Rule[], filters: Pick<WidgetFilters, 'tags' | 'ruleIds'>,
  scopes: Access, hierarchy: readonly HierarchyNode[],
): { stateRuleIds: Set<string>; activityRuleCount: number } {
  const enabled = enabledRulesOfCategory(category, allRules, filters);
  const stateRuleIds = new Set(enabled.filter(r => countsTowardPosture(r) && ruleOverlapsScopes(r, scopes, hierarchy)).map(r => r.id));
  return { stateRuleIds, activityRuleCount: enabled.filter(isActivityRule).length };
}

/** Splits a scope's rule ids by outcome against its findings: passing (zero findings, proven
 *  success), or unknown (zero findings but not a proven success, including never run). A rule
 *  with an active finding is skipped: it's implicitly failing, and never 'unknown' even if its
 *  last run technically errored, since the finding is real even if not exhaustive (spec 004's
 *  capped/failed distinction). */
function splitRuleOutcomes(ruleIds: Set<string>, findings: FindingSummary[], ruleById: Map<string, Rule>): { passing: number; unknown: number } {
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
  f: FindingSummary,
  filters: WidgetFilters,
  ruleById: Map<string, Rule>,
  suppressedFingerprints: Set<string>,
): boolean {
  if (suppressedFingerprints.has(f.fingerprint)) return false;
  if (filters.categories?.length && !filters.categories.includes(f.category)) return false;
  if (filters.subscriptions?.length && !filters.subscriptions.includes(subscriptionValue(f))) return false;
  if (filters.resourceGroups?.length && (!f.resourceGroup || !filters.resourceGroups.includes(f.resourceGroup))) return false;
  if (filters.severities?.length && !filters.severities.includes(f.severity)) return false;
  if (filters.ruleIds?.length && !filters.ruleIds.includes(f.ruleId)) return false;
  if (filters.tags?.length) {
    const ruleTags = ruleById.get(f.ruleId)?.tags ?? [];
    if (!filters.tags.some(t => ruleTags.includes(t))) return false;
  }
  return true;
}

async function suppressedFingerprintSet(access: Access): Promise<Set<string>> {
  return new Set((await loadSuppressions(access)).filter(isActiveSuppression).map(s => s.fingerprint));
}

/** Findings matching every dimension in `filters`, never an actively-suppressed one. */
async function narrow<T extends FindingSummary>(all: T[], filters: WidgetFilters, access: Access): Promise<T[]> {
  const ruleById = new Map((await loadRules()).map(r => [r.id, r]));
  const suppressed = await suppressedFingerprintSet(access);
  return all.filter(f => matchesFilters(f, filters, ruleById, suppressed));
}

/** Without their rows: every caller counts or lists findings and none reads a row. A caller that
 *  runs a view over rows uses queryActiveFindingsWithRows. */
export async function queryActiveFindings(filters: WidgetFilters, access: Access): Promise<FindingSummary[]> {
  return narrow(await listFindingSummaries(access, { status: 'active' }), filters, access);
}

/** queryActiveFindings() with every finding's rows, for a caller that runs the view engine. */
export async function queryActiveFindingsWithRows(filters: WidgetFilters, access: Access): Promise<FindingRecord[]> {
  return narrow(await listFindings(access, { status: 'active' }), filters, access);
}

async function queryFixedFindings(filters: WidgetFilters, access: Access): Promise<FindingSummary[]> {
  return narrow(await listFindingSummaries(access, { status: 'fixed' }), filters, access);
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
      pct: posturePct(e.passing, e.total),
      findings: e.findings,
      passing: e.passing,
      total: e.total,
    }));
}

function groupSnapshotsByCategory(snaps: DailySnapshot[]): Record<string, Array<{ date: string; pct: number | null; findings: number; passing: number; total: number }>> {
  const map: Record<string, Array<{ date: string; pct: number | null; findings: number; passing: number; total: number }>> = {};
  for (const s of snaps) {
    (map[s.category] ??= []).push({ date: s.date, pct: posturePct(s.passingRules, s.totalRules), findings: s.activeFindings, passing: s.passingRules, total: s.totalRules });
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
    /** Zero active findings but the rule's last run wasn't a proven success (or it has never run),
     *  neither passing nor failing (spec 030). Never folded into passingRules or totalRules. */
    unknownRules: number;
    /** 'activity'-kind rules in scope, excluded from totalRules/passingRules entirely. They can
     *  never be scored the same way (no meaningful "zero findings" passing state). */
    activityRuleCount: number;
    activeFindings: number;
    severityCounts: Record<Severity, number>;
    newInWindow: number;
    fixedInWindow: number;
  };
  /** Net lifecycle change over the window (newInWindow − fixedInWindow). A count, not a level
   *  comparison against a past snapshot. See DATA-SOURCE-UNIFICATION-PLAN.md §3. */
  deltaFindings: number | null;
  perCategory: Array<{
    category: string; label: string; color?: string; pct: number | null; activeFindings: number;
    /** Same passing/total the pct is rounded from. The honest headline (spec 033), with pct as
     *  the secondary, rounded figure. */
    passing: number; total: number;
    /** The newest finished scan of the category that covered part of what the viewer holds (anything,
     *  for Everything). Read from scans, never from a trend point's time. */
    lastScanAt: string | null;
    /** Enabled rules of any kind whose last run failed, was capped or was invalid, among those that look at
     *  what the viewer holds. Ignores the Scope, tag, rule and severity filters, and is not the ring's
     *  unknown count (a rule that never ran is unknown there and not counted here). */
    incompleteRuleCount: number;
  }>;
  /** Per-subscription posture, derived live from findings (no schema change): only subscriptions
   *  with at least one active finding appear (there's no tenant-wide subscription list without a
   *  live ARM call), sorted worst-posture-first. `pct`/`totalRules` mirror the per-category
   *  calc: rules with zero violations in that subscription / rules in scope for the active
   *  category+rule filters. */
  perSubscription: Array<{ subscriptionId: string; pct: number | null; activeFindings: number; totalRules: number; passingRules: number }>;
  /** Daily created-vs-resolved counts for the New vs Fixed widget: available under every filter
   *  combination (subscription/RG/severity via a fingerprint join to `findings`, tags resolved to
   *  rule ids), unlike the snapshot-sourced `trend`. */
  newVsFixedTrend: Array<{ date: string; created: number; resolved: number }>;
  /** Daily occurrence counts for kind:'activity' findings. The Activity Occurrences widget's
   *  data source (spec 034). Same filter support as newVsFixedTrend (subscription/RG/severity via
   *  a fingerprint join, tags resolved to rule ids). Empty when nothing in scope is activity-kind.
   *  The widget renders its own empty state for that, it isn't an error. */
  activityTrend: Array<{ date: string; count: number }>;
  lastScanAt: string | null;
  /** Whether the viewer holds Everything, so the incomplete-rule link asks for reach only of those who do not. */
  holdsEverything: boolean;

  // --- historical, snapshot-sourced: computed from `posture_snapshots`, needed because a past
  //     percentage requires the past denominator (rules enabled / resources in scope at that
  //     time), which live findings can't reconstruct. Null under filters snapshots can't
  //     represent: see `trendIsCategoryScopedOnly`. ---
  /** `date` is the oldest per-category baseline row's date actually reached (categories can each
   *  land on a different snapshot date), always show this, not an assumed "N days ago". */
  baseline: { pct: number | null; date: string } | null;
  /** Points of change from `baseline` to the live number, from the unrounded ratios and rounded once
   *  (lib/posture-math.ts). Null when there is no baseline. */
  deltaPct: number | null;
  /** Why `baseline` is null although a trend is served: some category has no point the version-equality
   *  table counts equal on or before `needed`. Null when a baseline was built or no trend is served. */
  baselineGap: BaselineGap | null;
  trend: Array<{ date: string; pct: number | null; findings: number; passing: number; total: number }>;
  trendByCategory?: Record<string, Array<{ date: string; pct: number | null; findings: number; passing: number; total: number }>>;
  /** True when `trend`/`baseline`/`deltaPct` are unavailable for the active filters, i.e.
   *  anything beyond category + at most one subscription (RG/tag/severity/rule, or more than one
   *  subscription at once). `deltaFindings` is findings-sourced and stays available regardless.
   *  Name kept from pre-Phase-5 for call-site stability. */
  trendIsCategoryScopedOnly: boolean;
  /** Why `trend`, `baseline` and `deltaPct` are empty for this person (#274): they are kept per
   *  subscription, and the person holds no whole subscription or has not chosen one. Null when the
   *  trend is served, or empty for a reason `trendIsCategoryScopedOnly` already gives. */
  trendUnavailable: TrendReason | null;
}

/** Live posture/findings numbers from the findings lifecycle table, plus trend/baseline
 *  history from posture_snapshots (meaningful when `filters` narrows to category and/or a
 *  single subscription: snapshots are recorded per category × subscription (Phase 5); any
 *  RG/tag/severity/rule filter, or more than one subscription at once, makes "trend over time"
 *  ill-defined at that granularity since it isn't recorded). */
export async function computeWidgetSummary(filters: WidgetFilters, trendDays: number, access: Access): Promise<WidgetSummary> {
  const { from, to } = resolveDateWindow(filters.dateWindow);
  const allCategories = await listCategories();
  const allRules = await loadRules();
  const ruleById = new Map(allRules.map(r => [r.id, r]));
  const targetCategories = filters.categories?.length
    ? allCategories.filter(c => filters.categories!.includes(c.id))
    : allCategories;

  // queryActiveFindings stays unfiltered here (other callers, e.g. suppression round-trips, need
  // the full active set); this view filters to what counts toward a finding-level total.
  const activeFindings = (await queryActiveFindings(filters, access)).filter(countsInFindingTotals);

  const severityCounts = emptySeverityCounts();
  for (const f of activeFindings) {
    if (f.severity in severityCounts) severityCounts[f.severity]++;
  }

  // The tree is read only when a counted rule could need it: below Everything, a rule that names a
  // management group is expanded over the stored copy.
  const scopes = await postureScopes(filters, access);
  const hierarchy = !scopes.everything && allRules.some(r => r.scope.managementGroups?.length) ? await listHierarchyNodes() : [];

  const countedByCategory = new Map(targetCategories.map(cat => [cat.id, countedRulesForCategory(cat, allRules, filters, scopes, hierarchy)]));
  const scopedRuleIds = new Set<string>();
  let totalRules = 0;
  let passingRules = 0;
  let unknownRules = 0;
  let activityRuleCount = 0;
  for (const cat of targetCategories) {
    const { stateRuleIds, activityRuleCount: catActivity } = countedByCategory.get(cat.id)!;
    for (const id of stateRuleIds) scopedRuleIds.add(id);
    totalRules += stateRuleIds.size;
    activityRuleCount += catActivity;
    const outcome = splitRuleOutcomes(stateRuleIds, activeFindings.filter(f => f.category === cat.id), ruleById);
    passingRules += outcome.passing;
    unknownRules += outcome.unknown;
  }

  const pct = posturePct(passingRules, totalRules);

  const newInWindow = activeFindings.filter(f => isWithinRange(f.firstSeenAt, from, to)).length;
  const fixedFindings = (await queryFixedFindings(filters, access)).filter(countsInFindingTotals);
  const fixedInWindow = fixedFindings.filter(f => isWithinRange(f.resolvedAt, from, to)).length;

  // Findings-sourced, not snapshot-sourced: net lifecycle change over the window, using the same
  // firstSeenAt/resolvedAt predicate as Scans' getRecencyStatus, so this always agrees with the
  // Scans page and works under every filter (unlike deltaPct/baseline, which need a snapshot).
  const deltaFindings = newInWindow - fixedInWindow;

  // When each target category was last scanned, for the per-category lastScanAt and the overall one
  // below: the newest scan that covered part of what the viewer holds, read from the scans themselves.
  const lastScanTimes = await listLastScanTimes(targetCategories.map(c => c.id), access);

  const perCategory = targetCategories.map(cat => {
    const { stateRuleIds } = countedByCategory.get(cat.id)!;
    const catTotal = stateRuleIds.size;
    const catFindings = activeFindings.filter(f => f.category === cat.id);
    const { passing: catPassing } = splitRuleOutcomes(stateRuleIds, catFindings, ruleById);
    const catPct = posturePct(catPassing, catTotal);
    return {
      category: cat.id,
      label: cat.label,
      color: cat.color,
      pct: catPct,
      activeFindings: catFindings.length,
      passing: catPassing,
      total: catTotal,
      lastScanAt: lastScanTimes.get(cat.id) ?? null,
      incompleteRuleCount: incompleteRulesOf(cat.id, allRules, access, hierarchy).length,
    };
  });

  const lastScanAt = perCategory.reduce<string | null>((max, m) => {
    if (!m.lastScanAt) return max;
    return !max || m.lastScanAt > max ? m.lastScanAt : max;
  }, null);

  const current: WidgetSummary['current'] = {
    pct, passingRules, totalRules, unknownRules, activityRuleCount,
    activeFindings: activeFindings.length,
    severityCounts, newInWindow, fixedInWindow,
  };

  // Only subscriptions with at least one active finding are knowable without a live ARM call:
  // see WidgetSummary's perSubscription doc comment.
  const subIds = Array.from(new Set(activeFindings.map(f => f.subscriptionId).filter(Boolean)));
  const perSubscription = subIds.map(subId => {
    const subFindings = activeFindings.filter(f => f.subscriptionId === subId);
    const total = scopedRuleIds.size;
    const { passing } = splitRuleOutcomes(scopedRuleIds, subFindings, ruleById);
    return {
      subscriptionId: subId,
      pct: posturePct(passing, total),
      activeFindings: subFindings.length,
      totalRules: total,
      passingRules: passing,
    };
  }).sort((a, b) => (a.pct ?? 101) - (b.pct ?? 101) || b.activeFindings - a.activeFindings);

  // New vs Fixed supports every filter dimension: subscription/RG/severity via a join to the
  // findings row (see getFindingEventCounts), tags resolved here to rule ids (rules own tags,
  // same predicate as matchesFilters). An empty tag∩rule intersection must yield zero events,
  // not "no filter": hence the impossible-id sentinel.
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
  }, access);
  const activityTrend = await getActivityOccurrenceCounts({
    categories: eventCategoryIds,
    ruleIds: eventRuleIds,
    subscriptions: filters.subscriptions,
    resourceGroups: filters.resourceGroups,
    severities: filters.severities,
    sinceDate: daysAgo(trendDays),
  }, access);

  // Trend/baseline need a representation in posture_snapshots. Category is always supported
  // (snapshots are recorded per category). A *single* subscription is also supported: snapshots
  // now carry a per-subscription breakdown (Phase 5), but RG/tag/severity/rule filters aren't
  // recorded at all, and combining more than one subscription can't be reconstructed from summed
  // per-subscription totals (each rule's pass/fail would need to be evaluated across the union of
  // subscriptions, which isn't recoverable from the stored per-day counts). Directory is not a
  // subscription and no snapshot is recorded for it, so choosing it is unsupported too.
  const hasUnsupportedTrendFilter = Boolean(
    filters.resourceGroups?.length || filters.tags?.length ||
    filters.severities?.length || filters.ruleIds?.length ||
    (filters.subscriptions && filters.subscriptions.length > 1) ||
    filters.subscriptions?.includes(DIRECTORY_SUBSCRIPTION),
  );

  if (hasUnsupportedTrendFilter) {
    return {
      current, baseline: null, deltaPct: null, baselineGap: null, deltaFindings,
      perCategory, perSubscription, trend: [], newVsFixedTrend, activityTrend, lastScanAt, holdsEverything: access.everything, trendIsCategoryScopedOnly: true,
      trendUnavailable: null,
    };
  }

  const trendCategoryIds = filters.categories?.length ? filters.categories : allCategories.map(c => c.id);
  const trendScope = trendScopeOf(access, filters.subscriptions);
  if (!trendScope.available) {
    return {
      current, baseline: null, deltaPct: null, baselineGap: null, deltaFindings,
      perCategory, perSubscription, trend: [], newVsFixedTrend, activityTrend, lastScanAt, holdsEverything: access.everything, trendIsCategoryScopedOnly: false,
      trendUnavailable: trendScope.reason,
    };
  }
  const trendSubscriptionId = trendScope.subscriptionId;
  const snaps = await getSnapshots(access, { categories: trendCategoryIds, subscriptionId: trendSubscriptionId, sinceDate: daysAgo(trendDays) });
  const trend = aggregateSnapshotsByDate(snaps);
  const trendByCategory = groupSnapshotsByCategory(snaps);

  // The baseline is each category's newest point that the version-equality table counts equal, on or
  // before the day before the window's first day. If any category has none, there is no baseline:
  // building one from the rest would compare two different sets of rules, so the delta is withheld
  // and the gap names the date needed and the earliest date every category could be compared from.
  const level = trendSubscriptionId ? 'subscription' : 'install';
  const equalFormulas = equalFormulaVersions(level);
  const needed = dayBefore(from);
  const baselineSnaps = await getBaselineSnapshots(trendCategoryIds, needed, access, trendSubscriptionId, equalFormulas);
  let baseline: WidgetSummary['baseline'] = null;
  let deltaPct: number | null = null;
  let baselineGap: BaselineGap | null = null;
  if (trendCategoryIds.length > 0 && baselineSnaps.length === trendCategoryIds.length) {
    const baselinePassing = baselineSnaps.reduce((s, x) => s + x.passingRules, 0);
    const baselineTotal = baselineSnaps.reduce((s, x) => s + x.totalRules, 0);
    // Categories can each land on a different snapshot date (missed scans, backfill drift). The
    // oldest is the honest bound for "how far back does this comparison actually reach".
    const oldestDate = baselineSnaps.reduce((min, x) => (x.date < min ? x.date : min), baselineSnaps[0].date);
    baseline = { pct: posturePct(baselinePassing, baselineTotal), date: oldestDate };
    deltaPct = postureDelta({ passing: passingRules, total: totalRules }, { passing: baselinePassing, total: baselineTotal });
  } else if (trendCategoryIds.length > 0) {
    const firstDates = await getFirstSnapshotDates(trendCategoryIds, access, trendSubscriptionId, equalFormulas);
    const earliest = firstDates.size === trendCategoryIds.length
      ? [...firstDates.values()].reduce((max, d) => (d > max ? d : max))
      : null;
    baselineGap = { needed, earliest, level };
  }

  return {
    current, baseline, deltaPct, baselineGap, deltaFindings,
    perCategory, perSubscription, trend, trendByCategory, newVsFixedTrend, activityTrend, lastScanAt, holdsEverything: access.everything,
    trendIsCategoryScopedOnly: false, trendUnavailable: null,
  };
}
