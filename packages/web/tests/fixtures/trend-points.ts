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

const SUB_LOWER = '3f2a9c1e-7b4d-4a6e-9d10-5c8e2b7a1f40';
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

/** Orders points the way the tests compare them. */
export const byPointKey = (a: Record<string, unknown>, b: Record<string, unknown>): number =>
  `${a.category}|${a.subscription_id}|${a.date}`.localeCompare(`${b.category}|${b.subscription_id}|${b.date}`);

/** True for a point dated before today, which is every point the upgrade must not touch. */
export const isPreToday = (p: Record<string, unknown>): boolean => String(p.date) < daysAgo(0);
