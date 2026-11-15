/**
 * What a withheld posture baseline says (ADR 0013). A baseline is built only when every category has a
 * point the version-equality table counts equal; otherwise the change is withheld rather than compared
 * across a different set of rules, and these words name the date it needed and the earliest date it
 * could use. Pure and client-safe.
 */

import type { TrendLevel } from './trend-version-equality';

/** Why no baseline was built: `needed` is the day before the window's first day, `earliest` the first
 *  date every category has a comparable point from (null when some category has none yet), and `level`
 *  where the points are kept. */
export interface BaselineGap {
  needed: string;
  earliest: string | null;
  level: TrendLevel;
}

export function baselineGapMessage(gap: BaselineGap): { title: string; detail: string } {
  const title = `No comparable count on ${gap.needed}`;
  if (!gap.earliest) return { title, detail: 'Not every category has a count that can be compared yet.' };
  return {
    title,
    detail: gap.level === 'install'
      ? `The earliest date every category can be compared from is ${gap.earliest}.`
      : `Counts at this level start on ${gap.earliest}.`,
  };
}
