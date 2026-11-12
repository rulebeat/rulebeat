import { listFindings, listFindingSummaries, getActivityOccurrenceCounts, type FindingRecord, type FindingSummary } from './db/findings';
import { loadRules } from './rules';
import { listCategories } from './db/categories';
import { loadSuppressions, isActiveSuppression } from './suppressions';
import { getSnapshots, getBaselineSnapshots, getFirstSnapshotDates } from './db/snapshots';
import { getRecencyStatus, isFixedInWindow } from './explorer-filters';
import { posturePct, postureDelta } from './posture-math';
import { equalFormulaVersions, type TrendLevel } from './trend-version-equality';
import { aggregateLine, trendLines, trendMarkerDates, type AggregateTrendPoint, type TrendPoint } from './trend-points';
import type { BaselineGap } from './posture-baseline';
import { trendAllowedFor, trendScopeOf, type TrendReason } from './trend-scope';
import { resolveDateWindow, todayKey } from './date-window';
import { listLastScanTimes } from './scan-history';
import type { WidgetFilters } from './dashboard-filters';
import type { Category, Rule, Severity } from './types';
import { emptySeverityCounts } from './severity';
import { DIRECTORY_SUBSCRIPTION, isOutsidePlacement, subscriptionValue } from './placement';
import { countsTowardPosture, countsInFindingTotals, isActivityRule } from './finding-kinds';
import { accessReach, holdsNoScope, type Access } from './access-model';
import { listHierarchyNodes } from './db/management-group-hierarchy';
import type { HierarchyNode } from './management-group-tree';
import { incompleteRulesOf, namesUnexpandableGroup, narrowScopes, ruleOverlapsScopes } from './rule-overlap';
import { knownSubscriptions } from './known-subscriptions';
import { buildSubscriptionRows } from './subscription-scorecard';
import type { SubscriptionRow } from './subscription-rows';
import { coversDirectory } from './run-scope';
import {
  ACTIVITY_KEPT_DAYS, TREND_KEPT_DAYS, WIDGET_LIMITS, activityRetentionNote, categoryEmptyLabel, postureEmptyReason,
  postureLimitNote, ruleSelectionNote, severityMeasure, trendRetentionNote,
} from './widget-limits';

function dayBefore(dateKey: string): string {
  return new Date(new Date(`${dateKey}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
}

function addDays(dateKey: string, days: number): string {
  return new Date(new Date(`${dateKey}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** The first day a chart kept for `keptDays` days can draw: today and the days-1 before it. */
function firstKeptDay(keptDays: number): string {
  return addDays(todayKey(), -(keptDays - 1));
}

/** Every day key from `from` to `to`, inclusive. */
function dayKeysBetween(from: string, to: string): string[] {
  const keys: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) keys.push(day);
  return keys;
}

/** Per-UTC-day New and Fixed counts, zero-filled across the window, from the findings' own timestamps
 *  and the Scans predicates (getRecencyStatus, isFixedInWindow) applied to that one day, so a bar equals
 *  the one-day Scans list it opens. A finding opened and fixed inside the window is Fixed only, and a
 *  reactivated finding keeps its first-seen date, so it is not New. */
function newVsFixedByDay(from: string, to: string, open: readonly FindingSummary[], fixed: readonly FindingSummary[]): WidgetSummary['newVsFixedTrend'] {
  const bars = new Map(dayKeysBetween(from, to).map(date => [date, { date, created: 0, resolved: 0 }]));
  for (const f of open) {
    const bar = f.firstSeenAt ? bars.get(f.firstSeenAt.slice(0, 10)) : undefined;
    if (bar && getRecencyStatus(f, bar.date, bar.date) === 'new') bar.created++;
  }
  for (const f of fixed) {
    const bar = f.resolvedAt ? bars.get(f.resolvedAt.slice(0, 10)) : undefined;
    if (bar && isFixedInWindow(f, bar.date, bar.date)) bar.resolved++;
  }
  return [...bars.values()];
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

/** The Problem rules the Subscription scorecard grades each row by: enabled, in a target category and
 *  matching the rule-level filters. A row keeps the ones whose scope overlaps it. */
function scorecardRules(categories: Category[], allRules: Rule[], filters: Pick<WidgetFilters, 'tags' | 'ruleIds'>): Rule[] {
  return categories.flatMap(cat => enabledRulesOfCategory(cat, allRules, filters).filter(countsTowardPosture));
}

/** Whether a selected rule is left out for one of the three reasons the note names: it no longer
 *  exists, it is disabled, or it looks at nothing the viewer holds. Judged on the rule list before the
 *  category, tag, Scope and kind filters narrow it, so a rule those filters drop is not blamed. */
function selectedRuleIsUncounted(rule: Rule | undefined, access: Access, hierarchy: readonly HierarchyNode[]): boolean {
  if (!rule || !rule.enabled) return true;
  return countsTowardPosture(rule) && !ruleOverlapsScopes(rule, access, hierarchy);
}

/** Why a posture has nothing to count, in the order a viewer can act on it: they hold no Scope; no
 *  enabled Problem rule looks at anything they hold (whatever the filters); or the filters excluded
 *  every rule that does. A viewer on Everything with no counted rule at all is told there are no
 *  enabled rules, since for them every rule looks at what they hold. */
function emptyReasonFor(access: Access, categories: Category[], allRules: Rule[], hierarchy: readonly HierarchyNode[]): { title: string; detail: string } {
  if (holdsNoScope(access)) return postureEmptyReason('no-access');
  const anyCountable = categories.some(cat => countedRulesForCategory(cat, allRules, {}, access, hierarchy).stateRuleIds.size > 0);
  if (anyCountable) return postureEmptyReason('filter-left-nothing');
  return postureEmptyReason(access.everything ? 'no-enabled-rules' : 'no-rules-here');
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
  /** Net change over the window (newInWindow − fixedInWindow), a count of findings, shown on the Open
   *  findings Stat Card. A finding opened and fixed inside the window counts only as Fixed. Not a level
   *  comparison against a past snapshot. See DATA-SOURCE-UNIFICATION-PLAN.md §3. */
  deltaFindings: number | null;
  /** Limit notes the ring, the posture Stat Card and the Category scorecard show: what "passing" means
   *  for this viewer, then the rule-scoped note when some selected rules are left out of the count. */
  postureNotes: string[];
  /** What the posture measures under a Severity filter ("Rules with no High finding"), else null. */
  measure: string | null;
  /** Why there is nothing to count when `current.totalRules` is 0, else null. */
  emptyReason: { title: string; detail: string } | null;
  perCategory: Array<{
    category: string; label: string; color?: string; pct: number | null; activeFindings: number;
    /** Same passing/total the pct is rounded from. The honest headline (spec 033), with pct as
     *  the secondary, rounded figure. */
    passing: number; total: number;
    /** The newest finished scan of the category that covered part of what the viewer holds (anything,
     *  for Everything). Read from scans, never from a trend point's time. */
    lastScanAt: string | null;
    /** Counted rules with zero findings whose last run was not a proven success: the part of `total`
     *  that is neither passing nor failing. */
    unknown: number;
    /** What the tile reads when `total` is 0, by whether the viewer holds Everything. Null otherwise. */
    emptyLabel: string | null;
    /** Enabled rules of any kind whose last run failed, was capped or was invalid, among those that look at
     *  what the viewer holds. Ignores the Scope, tag, rule and severity filters, and is not the ring's
     *  unknown count (a rule that never ran is unknown there and not counted here). */
    incompleteRuleCount: number;
  }>;
  /** The Subscription scorecard's rows, lowest first: every subscription RuleBeat knows within the
   *  viewer's Access (the tree's, a rule's scope names, or holding a finding) and the Directory for
   *  whoever holds it. Each is graded by the rules whose scope overlaps it, and failing is findings
   *  placed inside it. */
  perSubscription: SubscriptionRow[];
  /** The limit notes the Subscription scorecard shows: how a rule counts for a subscription (W2), and
   *  while a rule's management group is not in the stored tree, what that does (W3). */
  subscriptionNotes: string[];
  /** Active, unsuppressed Problem findings placed at a management group or nowhere, which no row counts,
   *  narrowed by the category, rule, tag and severity filters within the viewer's Access. Null under a
   *  subscription, resource group or Directory filter, where the footer is hidden. */
  outsideSubscriptions: number | null;
  /** Per-UTC-day New and Fixed counts for the New vs Fixed widget, one bar for every day of the date
   *  window, zero-filled. Counted from the live findings with the Scans predicates, Problem findings
   *  only and never a suppressed one, so each bar equals the one-day Scans list it opens. Available
   *  under every filter combination, unlike the snapshot-sourced `trend`. */
  newVsFixedTrend: Array<{ date: string; created: number; resolved: number }>;
  /** Daily occurrence counts for kind:'activity' findings. The Activity Occurrences widget's
   *  data source (spec 034). Subscription, resource group and severity filters
   *  narrow it by the finding's own columns, and tags are resolved to rule ids. Empty when nothing in scope is activity-kind.
   *  The widget renders its own empty state for that, it isn't an error. */
  activityTrend: Array<{ date: string; count: number }>;
  /** The note a chart carries when the date window reaches past the 365 days of trend points, or the 180
   *  days of activity occurrences, saying which day it starts on. Null while the window sits inside them. */
  trendRetentionNote: string | null;
  activityRetentionNote: string | null;
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
  /** The all-categories line, starting on the first day every category has a count. Quiet days are carried
   *  from the category's last point (lib/trend-points.ts). */
  trend: AggregateTrendPoint[];
  /** Each category's own line, starting at its own first point, over today's categories only. Every point
   *  carries the formula version it was counted under, and whether it is a carried day. */
  trendByCategory?: Record<string, TrendPoint[]>;
  /** Where the trend is kept for this request: the whole install, one subscription or the Directory.
   *  Null when no trend is served. */
  trendLevel?: TrendLevel | null;
  /** The notes a served trend carries: W2 on a subscription's trend, and "Counted differently before
   *  <date>" once for each distinct day a line's counting changed. */
  trendNotes?: string[];
  /** True when `trend`/`baseline`/`deltaPct` are unavailable for the active filters, i.e.
   *  anything the allow-list in lib/trend-scope.ts does not serve (RG/tag/severity/rule, or more than
   *  one subscription at once). `deltaFindings` is findings-sourced and stays available regardless.
   *  Name kept from pre-Phase-5 for call-site stability. */
  trendIsCategoryScopedOnly: boolean;
  /** Why `trend`, `baseline` and `deltaPct` are empty for this person (#274): they are kept per
   *  subscription and for the Directory, and the person holds neither or has not chosen one. Null when the
   *  trend is served, or empty for a reason `trendIsCategoryScopedOnly` already gives. */
  trendUnavailable: TrendReason | null;
}

/** Live posture/findings numbers from the findings lifecycle table, plus trend/baseline
 *  history from posture_snapshots (meaningful when `filters` narrows to category and/or a
 *  single subscription or the Directory: points are recorded per category for the install, each
 *  subscription and the Directory; any RG/tag/severity/rule filter, or more than one subscription at
 *  once, makes "trend over time" ill-defined at that granularity since it isn't recorded). */
export async function computeWidgetSummary(filters: WidgetFilters, access: Access): Promise<WidgetSummary> {
  const { from, to } = resolveDateWindow(filters.dateWindow);
  const allCategories = await listCategories();
  const allRules = await loadRules();
  const ruleById = new Map(allRules.map(r => [r.id, r]));
  const targetCategories = filters.categories?.length
    ? allCategories.filter(c => filters.categories!.includes(c.id))
    : allCategories;

  // queryActiveFindings stays unfiltered here (other callers, e.g. suppression round-trips, need
  // the full active set); this view filters to what counts toward a finding-level total.
  const everyActive = await listFindingSummaries(access, { status: 'active' });
  const activeFindings = (await narrow(everyActive, filters, access)).filter(countsInFindingTotals);

  const severityCounts = emptySeverityCounts();
  for (const f of activeFindings) {
    if (f.severity in severityCounts) severityCounts[f.severity]++;
  }

  // The stored tree names the subscriptions the Subscription scorecard lists and expands a rule's
  // management group, for a row or for anyone below Everything.
  const scopes = await postureScopes(filters, access);
  const hierarchy = await listHierarchyNodes();

  const countedByCategory = new Map(targetCategories.map(cat => [cat.id, countedRulesForCategory(cat, allRules, filters, scopes, hierarchy)]));
  let totalRules = 0;
  let passingRules = 0;
  let unknownRules = 0;
  let activityRuleCount = 0;
  for (const cat of targetCategories) {
    const { stateRuleIds, activityRuleCount: catActivity } = countedByCategory.get(cat.id)!;
    totalRules += stateRuleIds.size;
    activityRuleCount += catActivity;
    const outcome = splitRuleOutcomes(stateRuleIds, activeFindings.filter(f => f.category === cat.id), ruleById);
    passingRules += outcome.passing;
    unknownRules += outcome.unknown;
  }

  const pct = posturePct(passingRules, totalRules);

  const selectedRuleIds = [...new Set(filters.ruleIds ?? [])];
  const postureLimits = {
    postureNotes: [
      postureLimitNote(access.everything),
      ...[ruleSelectionNote(selectedRuleIds.length, selectedRuleIds.filter(id => selectedRuleIsUncounted(ruleById.get(id), access, hierarchy)).length)].filter((n): n is string => n !== null),
    ],
    measure: severityMeasure(filters.severities),
    emptyReason: totalRules > 0 ? null : emptyReasonFor(access, allCategories, allRules, hierarchy),
  };

  // New and Fixed are the counts of the Scans New and Fixed lists for the window, by the Scans
  // predicates themselves: a reactivated finding keeps its old first-seen date, so it is not New, and a
  // finding opened and fixed inside the window is Fixed only.
  const newInWindow = activeFindings.filter(f => getRecencyStatus(f, from, to) === 'new').length;
  const fixedFindings = (await queryFixedFindings(filters, access)).filter(countsInFindingTotals);
  const fixedInWindow = fixedFindings.filter(f => isFixedInWindow(f, from, to)).length;

  // Findings-sourced, not snapshot-sourced: the net change in a count of findings over the window,
  // so it agrees with the Scans page and works under every filter (unlike deltaPct/baseline, which
  // need a snapshot).
  const deltaFindings = newInWindow - fixedInWindow;

  // When each target category was last scanned, for the per-category lastScanAt and the overall one
  // below: the newest scan that covered part of what the viewer holds, read from the scans themselves.
  const lastScanTimes = await listLastScanTimes(targetCategories.map(c => c.id), access);

  const perCategory = targetCategories.map(cat => {
    const { stateRuleIds } = countedByCategory.get(cat.id)!;
    const catTotal = stateRuleIds.size;
    const catFindings = activeFindings.filter(f => f.category === cat.id);
    const { passing: catPassing, unknown: catUnknown } = splitRuleOutcomes(stateRuleIds, catFindings, ruleById);
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
      unknown: catUnknown,
      emptyLabel: catTotal === 0 ? categoryEmptyLabel(access.everything) : null,
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

  // Every subscription known within the viewer's Scopes gets a row, and the Directory for whoever holds it.
  const reach = accessReach(scopes);
  const inScopes = (key: string) => scopes.everything || reach.subscriptions.has(key) || reach.resourceGroups.has(key);
  const subscriptions = knownSubscriptions({
    hierarchy,
    rules: allRules,
    findingSubscriptions: everyActive.filter(f => countsInFindingTotals(f) && f.placement !== 'directory').map(f => f.subscriptionId),
  }).filter(sub => inScopes(sub.key));
  const perSubscription = buildSubscriptionRows({
    subscriptions,
    includeDirectory: coversDirectory(scopes),
    rules: scorecardRules(targetCategories, allRules, filters),
    findings: activeFindings,
    scopes,
    hierarchy,
  });
  const subscriptionNotes = [WIDGET_LIMITS.w2, ...(namesUnexpandableGroup(allRules, hierarchy) ? [WIDGET_LIMITS.w3] : [])];
  const outsideSubscriptions = filters.subscriptions?.length || filters.resourceGroups?.length
    ? null
    : activeFindings.filter(f => isOutsidePlacement(f.placement)).length;

  // The bars come from the live findings read above, so they carry every filter dimension the Scans
  // lists do and nothing the window's own range does not hold.
  const newVsFixedTrend = newVsFixedByDay(from, to, activeFindings, fixedFindings);

  // Activity occurrences still come from finding_events, which keeps 180 days. Tags are resolved here
  // to rule ids (rules own tags, same predicate as matchesFilters). An empty tag∩rule intersection
  // must yield zero events, not "no filter": hence the impossible-id sentinel.
  let eventRuleIds = filters.ruleIds;
  if (filters.tags?.length) {
    const tagRuleIds = allRules
      .filter(r => (r.tags ?? []).some(t => filters.tags!.includes(t)))
      .map(r => r.id);
    eventRuleIds = eventRuleIds?.length ? eventRuleIds.filter(id => tagRuleIds.includes(id)) : tagRuleIds;
    if (eventRuleIds.length === 0) eventRuleIds = ['__no-matching-rule__'];
  }
  const eventCategoryIds = filters.categories?.length ? filters.categories : allCategories.map(c => c.id);
  const activityStart = firstKeptDay(ACTIVITY_KEPT_DAYS);
  const activityTrend = (await getActivityOccurrenceCounts({
    categories: eventCategoryIds,
    ruleIds: eventRuleIds,
    subscriptions: filters.subscriptions,
    resourceGroups: filters.resourceGroups,
    severities: filters.severities,
    sinceDate: from > activityStart ? from : activityStart,
  }, access)).filter(d => d.date <= to);

  // A window that reaches past the data kept is told so on the chart, with the day it starts.
  const retentionNotes = {
    trendRetentionNote: from < firstKeptDay(TREND_KEPT_DAYS) ? trendRetentionNote(firstKeptDay(TREND_KEPT_DAYS)) : null,
    activityRetentionNote: from < activityStart ? activityRetentionNote(activityStart) : null,
  };

  // A stored point has a representation only under the filters the allow-list serves (lib/trend-scope.ts):
  // category, the date window and at most one subscription or the Directory. Any other filter would put
  // a filtered live number beside unfiltered points, so none of trend, baseline and delta is served.
  if (!trendAllowedFor(filters)) {
    return {
      current, baseline: null, deltaPct: null, baselineGap: null, deltaFindings, ...postureLimits, ...retentionNotes,
      perCategory, perSubscription, subscriptionNotes, outsideSubscriptions, trend: [], newVsFixedTrend, activityTrend, lastScanAt, holdsEverything: access.everything, trendIsCategoryScopedOnly: true,
      trendUnavailable: null,
    };
  }

  const trendCategoryIds = filters.categories?.length ? filters.categories : allCategories.map(c => c.id);
  const trendScope = trendScopeOf(access, filters.subscriptions);
  if (!trendScope.available) {
    return {
      current, baseline: null, deltaPct: null, baselineGap: null, deltaFindings, ...postureLimits, ...retentionNotes,
      perCategory, perSubscription, subscriptionNotes, outsideSubscriptions, trend: [], newVsFixedTrend, activityTrend, lastScanAt, holdsEverything: access.everything, trendIsCategoryScopedOnly: false,
      trendUnavailable: trendScope.reason,
    };
  }
  const trendSubscriptionId = trendScope.subscriptionId;
  const level: TrendLevel = !trendSubscriptionId ? 'install'
    : trendSubscriptionId.toLowerCase() === DIRECTORY_SUBSCRIPTION ? 'directory'
    : 'subscription';

  // The lines are drawn over today's categories only, from the window's first day or the first day of
  // trend points kept, whichever is later. The newest point on or before that day is read as well, so a
  // category with no point inside the window carries from it.
  const trendStart = firstKeptDay(TREND_KEPT_DAYS);
  const since = from > trendStart ? from : trendStart;
  const inWindow = (await getSnapshots(access, { categories: trendCategoryIds, subscriptionId: trendSubscriptionId, sinceDate: since }))
    .filter(s => s.date <= to);
  const beforeWindow = await getBaselineSnapshots(trendCategoryIds, since, access, trendSubscriptionId);
  const lines = trendLines([...beforeWindow, ...inWindow], since, to);
  const trend = aggregateLine(lines, trendCategoryIds);
  const trendByCategory = lines;
  const trendNotes = [
    ...(level === 'subscription' ? [WIDGET_LIMITS.w2] : []),
    ...trendMarkerDates(level, lines).map(WIDGET_LIMITS.w5),
  ];

  // The baseline is each category's newest point that the version-equality table counts equal, on or
  // before the day before the window's first day. If any category has none, there is no baseline:
  // building one from the rest would compare two different sets of rules, so the delta is withheld
  // and the gap names the date needed and the earliest date every category could be compared from.
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
    current, baseline, deltaPct, baselineGap, deltaFindings, ...postureLimits, ...retentionNotes,
    perCategory, perSubscription, subscriptionNotes, outsideSubscriptions, trend, trendByCategory, trendLevel: level, trendNotes, newVsFixedTrend, activityTrend, lastScanAt, holdsEverything: access.everything,
    trendIsCategoryScopedOnly: false, trendUnavailable: null,
  };
}
