/** Client-safe: what a widget's stored config says about how much it counts, shared by the widgets
 *  (to build a preview) and the routes (to read the stored value). */

/** The longest trend any widget may ask for. */
export const MAX_TREND_DAYS = 365;

/** The longest trend a widget may ask for, by widget type. Posture snapshots are kept for a year;
 *  finding events are pruned after 180 days, so a longer period is empty air. */
export const TREND_CAP_DAYS: Record<string, number> = {
  'trend': MAX_TREND_DAYS,
  'new-vs-fixed': 180,
  'activity-occurrences': 180,
};

export const DEFAULT_TREND_DAYS = 30;

/** Widget "period" config values → day counts. `allDays` is both what 'all' means and the longest
 *  period the caller's data source holds, so a stored `365d` on a 180-day source counts 180. */
export function periodToDays(period: string, allDays: number): number {
  if (period === 'all') return allDays;
  const days = /^(\d+)d$/.exec(period);
  if (!days) return DEFAULT_TREND_DAYS;
  return Math.min(Math.max(parseInt(days[1]!, 10), 1), allDays);
}

/** The trend length a widget of `type` counts for its stored config. */
export function storedTrendDays(type: string | undefined, config: Record<string, unknown>): number {
  const cap = type ? TREND_CAP_DAYS[type] : undefined;
  if (!cap) return DEFAULT_TREND_DAYS;
  const period = typeof config['period'] === 'string' ? config['period'] : '30d';
  return periodToDays(period, cap);
}

/** The row limit a widget's stored config asks for, or undefined when it sets none. */
export function storedLimit(config: Record<string, unknown>): number | undefined {
  const limit = config['limit'];
  return typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined;
}

/** The row count a widget type shows when its stored config sets no limit. It is the figure the
 *  config panel offers, so a widget saved without one (an upgraded findings table) keeps showing it. */
const DEFAULT_LIMITS: Record<string, number> = {
  'recent-findings': 10,
};

/** The row limit a widget of `type` counts: its stored config's, else the type's default. */
export function limitFor(type: string | undefined, config: Record<string, unknown>): number | undefined {
  return storedLimit(config) ?? (type ? DEFAULT_LIMITS[type] : undefined);
}
