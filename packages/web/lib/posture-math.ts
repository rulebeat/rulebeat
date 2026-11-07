/**
 * The one percentage and delta every posture reader uses (live ring and stat card, the trend, the
 * baseline), so two places never round the same ratio differently. Readers recompute from passing and
 * total and never read a stored posture_pct. Pure and client-safe.
 */

export interface PostureCount { passing: number; total: number }

/**
 * Passing over total as a whole percentage, or null when nothing is counted. Rounds to the nearest
 * whole number, but never reads 100 while a counted rule fails or is unknown, and never 0 while one
 * passes: a rounded 100 would say "nothing to fix" and a rounded 0 "nothing works".
 */
export function posturePct(passing: number, total: number): number | null {
  if (total <= 0) return null;
  const rounded = Math.round((passing / total) * 100);
  if (passing < total && rounded >= 100) return 99;
  if (passing > 0 && rounded <= 0) return 1;
  return rounded;
}

/**
 * Change in points from `baseline` to `current`, from the unrounded ratios and rounded once. 0 only
 * when the ratios are exactly equal (compared by cross-multiplying, so no division error decides it);
 * any other change that would round to 0 reads +1 or -1. Null when either side counts nothing.
 */
export function postureDelta(current: PostureCount, baseline: PostureCount): number | null {
  if (current.total <= 0 || baseline.total <= 0) return null;
  const sideways = current.passing * baseline.total - baseline.passing * current.total;
  if (sideways === 0) return 0;
  const points = (sideways / (current.total * baseline.total)) * 100;
  const rounded = Math.round(Math.abs(points));
  return Math.sign(points) * (rounded === 0 ? 1 : rounded);
}

/** "+25 pts vs 2026-10-01": a delta in points with the date it is measured from. */
export function pointsLabel(delta: number, baselineDate: string): string {
  if (delta === 0) return `flat vs ${baselineDate}`;
  return `${delta > 0 ? '+' : ''}${delta} ${Math.abs(delta) === 1 ? 'pt' : 'pts'} vs ${baselineDate}`;
}
