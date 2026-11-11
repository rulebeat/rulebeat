/**
 * The version-equality table (ADR 0013): the only place that decides whether two stored trend points
 * count the same thing, and so whether they may be drawn as one line or used as a baseline.
 * `docs/public/posture.md` repeats it under "When two counts are compared", and
 * trend-version-equality.test.ts fails when the two disagree. A version bump is a one-row edit here
 * and the matching row there. Pure and client-safe: no database imports.
 *
 * Until a trend point records its finding-count version, readers of a posture ratio (which counts rules,
 * not findings) compare on the formula version alone.
 */

/** Where a point is kept: the whole install per category, one subscription, or the Directory. */
export type TrendLevel = 'install' | 'subscription' | 'directory';

export interface VersionEquality {
  level: TrendLevel;
  /** The row's name in posture.md. */
  label: string;
  /** Formula versions counted equal at this level. Formula 1 equals nothing. */
  formula: readonly number[];
  /** Finding-count versions counted equal at this level. 0 ("not recorded") equals nothing. */
  findingCount: readonly number[];
}

export const VERSION_EQUALITY: readonly VersionEquality[] = [
  { level: 'install', label: 'Install-wide, per category', formula: [2, 3], findingCount: [1] },
  { level: 'subscription', label: 'One subscription', formula: [3], findingCount: [1] },
  { level: 'directory', label: 'The Directory', formula: [3], findingCount: [1] },
];

function rowFor(level: TrendLevel): VersionEquality {
  return VERSION_EQUALITY.find(row => row.level === level)!;
}

/** The formula versions a point at `level` may carry to be compared with a live number. */
export function equalFormulaVersions(level: TrendLevel): readonly number[] {
  return rowFor(level).formula;
}

/** Whether a point written under `formulaVersion` counts the same as today's at `level`. */
export function formulaCountsEqual(level: TrendLevel, formulaVersion: number): boolean {
  return rowFor(level).formula.includes(formulaVersion);
}

/** Whether a point written under `findingCountVersion` counts findings the same as today's at `level`. */
export function findingCountCountsEqual(level: TrendLevel, findingCountVersion: number): boolean {
  return rowFor(level).findingCount.includes(findingCountVersion);
}

/**
 * Whether two points of one line were counted the same way: written under the same formula version,
 * or under two versions this level's row counts equal. A change from one to the other is where a line
 * is marked "Counted differently before <date>".
 */
export function formulasComparable(level: TrendLevel, a: number, b: number): boolean {
  return a === b || (formulaCountsEqual(level, a) && formulaCountsEqual(level, b));
}
