/**
 * The posture_snapshots an install holds when it upgrades to the release that records
 * `finding_count_version` on every trend point, shared by the SQLite and Postgres upgrade tests so both
 * backends are held to the same data. The table is built as the previous release had it (no
 * `finding_count_version`), and the points cover every shape a later ticket has to treat differently:
 * a v1 point, v2 install-wide and per-subscription points, a point the scan-blob backfill wrote, today's
 * point, points past the retention window, a point of a category since deleted, and a subscription id
 * in upper case.
 */

const DAY_MS = 86_400_000;

export const daysAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);

/** Every column the previous release had, in table order. */
export const TREND_POINT_COLUMNS = [
  'category', 'subscription_id', 'date', 'posture_pct', 'passing_rules', 'total_rules', 'unknown_rules',
  'activity_rule_count', 'formula_version', 'active_findings', 'severity_counts', 'updated_at',
] as const;

export type TrendPoint = Record<(typeof TREND_POINT_COLUMNS)[number], string | number | null>;

/** The one subscription the points above are about, in lower case; its upper-case point is the same level. */
export const SUB_LOWER = '3f2a9c1e-7b4d-4a6e-9d10-5c8e2b7a1f40';
const SUB_UPPER = SUB_LOWER.toUpperCase();

function point(over: Partial<TrendPoint> & Pick<TrendPoint, 'category' | 'date'>): TrendPoint {
  return {
    subscription_id: '', posture_pct: 75, passing_rules: 3, total_rules: 4, unknown_rules: 0, activity_rule_count: 0,
    formula_version: 2, active_findings: 6, severity_counts: '{"high":2,"medium":4}', updated_at: `${over.date}T03:00:00.000Z`,
    ...over,
  };
}

/** A category that no longer exists: its points outlive it. */
export const DELETED_CATEGORY = 'retired-category';

export function trendPoints(): TrendPoint[] {
  return [
    point({ category: 'security', date: daysAgo(40), formula_version: 1, posture_pct: 90, passing_rules: 9, total_rules: 10, unknown_rules: 0 }),
    point({ category: 'security', date: daysAgo(20), formula_version: 2, unknown_rules: 1 }),
    point({ category: 'security', date: daysAgo(20), subscription_id: SUB_LOWER, posture_pct: 50, passing_rules: 2, active_findings: 3, severity_counts: '{"high":3}' }),
    // What the scan-blob backfill writes: past-dated, current formula, nothing for the unknown split.
    point({ category: 'security', date: daysAgo(10), posture_pct: 100, passing_rules: 4, active_findings: 0, severity_counts: '{}', updated_at: `${daysAgo(10)}T22:14:09.000Z` }),
    point({ category: 'security', subscription_id: SUB_UPPER, date: daysAgo(5), posture_pct: 25, passing_rules: 1, active_findings: 9, severity_counts: '{"critical":1,"high":8}' }),
    point({ category: 'security', date: daysAgo(366), posture_pct: 60, passing_rules: 3, total_rules: 5 }),
    point({ category: 'security', date: daysAgo(370), posture_pct: 40, passing_rules: 2, total_rules: 5 }),
    point({ category: DELETED_CATEGORY, date: daysAgo(366), posture_pct: 10, passing_rules: 1, total_rules: 10 }),
    point({ category: 'security', date: daysAgo(0), unknown_rules: 1, updated_at: new Date().toISOString() }),
  ];
}

/** Rules the upgrade must leave as they are. */
export const TREND_RULES = [
  { id: 'trend-rule-passing', name: 'Trend rule passing', category: 'security', last_run_status: 'success' },
  { id: 'trend-rule-failing', name: 'Trend rule failing', category: 'security', last_run_status: 'failed' },
] as const;

/** The management group tree the install holds: the subscription above with no finding and no rule naming it. */
export const TREND_TREE = [
  { tenant_id: 'tenant-trend', kind: 'managementGroup', node_id: 'tenant-trend', display_name: 'Tenant Root Group', parent_id: null },
  { tenant_id: 'tenant-trend', kind: 'subscription', node_id: SUB_LOWER, display_name: 'Trend subscription', parent_id: 'tenant-trend' },
] as const;

/** The key a point is found by, with the level in lower case: the same level in two cases is one key. */
export const levelKey = (p: Record<string, unknown>): string => `${p.category}|${String(p.subscription_id).toLowerCase()}|${p.date}`;

/** Orders points the way the tests compare them. */
export const byPointKey = (a: Record<string, unknown>, b: Record<string, unknown>): number =>
  `${a.category}|${a.subscription_id}|${a.date}`.localeCompare(`${b.category}|${b.subscription_id}|${b.date}`);

/** True for a point dated before today, which is every point the upgrade must not touch. */
export const isPreToday = (p: Record<string, unknown>): boolean => String(p.date) < daysAgo(0);

/**
 * What the first start on formula 3 must leave, read back through the dashboard's own reads (the one list
 * both upgrade tests share, so both backends are held to it). Call it after the product has started on the
 * upgraded database and the startup refresh has run. `todayRows` is every row of `security` dated today.
 *
 *  - Today is formula 3 and finding-count version 1 at every level.
 *  - The v2 install-wide point is accepted as a baseline.
 *  - The v2 per-subscription point is refused, naming the day it needed and the first day a v3 point exists.
 *  - The upper-case v2 subscription point is found, refused, carried over the quiet days after it, and the first
 *    v3 day is marked as the day the counting changed.
 *  - Today holds exactly one row for that level.
 */
export async function expectFormula3Reads(todayRows: Array<Record<string, unknown>>): Promise<void> {
  const { expect } = await import('vitest');
  const { computeWidgetSummary } = await import('@/lib/dashboard-data');
  const { everythingAccess } = await import('@/lib/access-model');
  const { baselineGapMessage } = await import('@/lib/posture-baseline');
  const { WIDGET_LIMITS } = await import('@/lib/widget-limits');
  const everything = everythingAccess('admin');
  const today = daysAgo(0);

  expect(todayRows.map(p => p.subscription_id).sort()).toEqual(['', SUB_LOWER, 'directory']);
  expect(todayRows.map(p => [p.formula_version, p.finding_count_version])).toEqual(todayRows.map(() => [3, 1]));
  expect(todayRows.filter(p => String(p.subscription_id).toLowerCase() === SUB_LOWER)).toHaveLength(1);

  // Install-wide: the newest point on or before the day before the window is the backfill-shaped v2 one, 10 days back.
  const install = await computeWidgetSummary({ categories: ['security'], dateWindow: { mode: 'relative', days: 7 } }, everything);
  expect(install.baseline).toMatchObject({ date: daysAgo(10) });
  expect(install.baselineGap).toBeNull();
  expect(install.deltaPct).not.toBeNull();

  // One subscription: its v2 points do not count equal, so there is no baseline and the gap names both dates.
  const subscription = await computeWidgetSummary({ categories: ['security'], subscriptions: [SUB_LOWER], dateWindow: { mode: 'relative', days: 7 } }, everything);
  expect(subscription.baseline).toBeNull();
  expect(subscription.deltaPct).toBeNull();
  expect(subscription.baselineGap).toEqual({ needed: daysAgo(7), earliest: today, level: 'subscription' });
  const message = baselineGapMessage(subscription.baselineGap!);
  expect(message.title).toContain(daysAgo(7));
  expect(message.detail).toContain(today);

  // The upper-case v2 point of five days back is the same level: drawn on its own day, carried after it, and the
  // first v3 day is marked.
  const drawn = await computeWidgetSummary({ categories: ['security'], subscriptions: [SUB_LOWER], dateWindow: { mode: 'relative', days: 10 } }, everything);
  const line = drawn.trendByCategory!.security!;
  expect(line.find(p => p.date === daysAgo(5))).toMatchObject({ formulaVersion: 2, findings: 9, carried: false });
  expect(line.filter(p => p.date > daysAgo(5) && p.date < today).map(p => [p.formulaVersion, p.findings, p.carried]))
    .toEqual([1, 2, 3, 4].map(() => [2, 9, true]));
  expect(line.at(-1)).toMatchObject({ date: today, formulaVersion: 3, carried: false });
  expect(drawn.trendNotes).toContain(WIDGET_LIMITS.w5(today));
}
