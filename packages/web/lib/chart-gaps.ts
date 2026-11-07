/** Turns dated records into chart rows where a day with no record is a gap, never a carried
 *  value and never a zero. A recorded zero is a number and draws at 0; a day nobody recorded is
 *  `null`, which the chart leaves empty, and its reason travels with the row so the tooltip and
 *  the hidden data table can say why. Pure and client-safe. */

export type GapReason = 'no-record' | 'earlier-formula';

export const GAP_REASON_TEXT: Record<GapReason, string> = {
  'no-record': 'No record for this day',
  'earlier-formula': 'Recorded under an earlier posture formula',
};

/** Every day from `from` to `to`, inclusive, as YYYY-MM-DD keys. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  if (from > to) return out;
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function shiftDay(day: string, days: number): string {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** The days a trend axis spans: from the first record (or the window start, whichever is later)
 *  through today, so a day since the last record shows as a gap rather than the axis stopping
 *  early. Empty when nothing was ever recorded. */
export function trendDays(recordedDates: readonly string[], windowDays: number, today: string): string[] {
  if (recordedDates.length === 0) return [];
  const first = [...recordedDates].sort()[0]!;
  const windowStart = shiftDay(today, -windowDays);
  return daysBetween(first > windowStart ? first : windowStart, today);
}

export interface TrendPoint {
  date: string;
  pct: number | null;
  passing: number;
  total: number;
  /** True when the day's rows were written under a posture formula this release no longer uses. */
  earlierFormula?: boolean;
}

export type TrendRow = { date: string } & Record<string, unknown>;

function gapOf(point: TrendPoint | undefined): GapReason | null {
  if (!point) return 'no-record';
  if (point.earlierFormula) return 'earlier-formula';
  return point.pct === null ? 'no-record' : null;
}

/** One row per day. For each series key: `[key]` is the percentage or `null`, `[key]__passing` and
 *  `[key]__total` carry the counts behind it, `[key]__gap` the reason it is null, and `[key]__lone`
 *  is true for a point with a gap on both sides, which a line cannot connect and must draw as a dot. */
export function trendRows(days: readonly string[], series: Record<string, readonly TrendPoint[]>): TrendRow[] {
  const byKey = new Map(Object.entries(series).map(([key, points]) => [key, new Map(points.map(p => [p.date, p]))]));
  const rows: TrendRow[] = days.map(date => {
    const row: TrendRow = { date };
    for (const [key, byDate] of byKey) {
      const point = byDate.get(date);
      const gap = gapOf(point);
      row[key] = gap === null ? point!.pct : null;
      row[`${key}__passing`] = point?.passing;
      row[`${key}__total`] = point?.total;
      row[`${key}__gap`] = gap;
    }
    return row;
  });
  rows.forEach((row, i) => {
    for (const key of byKey.keys()) {
      row[`${key}__lone`] = row[key] !== null && rows[i - 1]?.[key] == null && rows[i + 1]?.[key] == null;
    }
  });
  return rows;
}

export type CountRow<K extends string> = { date: string; gap: GapReason | null } & Record<K, number | null>;

/** Rows for a bar chart of daily counts. A day outside `recordedDays` with no counts is a gap
 *  (every count `null`); a recorded day with nothing in it keeps its zeros. `recordedDays` is
 *  `null` when the server has no record of scan days for this filter, in which case every day
 *  counts as recorded. A day with a count above zero is always recorded. */
export function countRows<K extends string>(
  counts: ReadonlyArray<{ date: string } & Record<K, number>>,
  keys: readonly K[],
  recordedDays: readonly string[] | null,
): Array<CountRow<K>> {
  const recorded = recordedDays === null ? null : new Set(recordedDays);
  return counts.map(c => {
    const hasCount = keys.some(k => c[k] > 0);
    const isGap = recorded !== null && !recorded.has(c.date) && !hasCount;
    const row = { date: c.date, gap: isGap ? 'no-record' : null } as CountRow<K>;
    for (const k of keys) (row as Record<K, number | null>)[k] = isGap ? null : c[k];
    return row;
  });
}
