/**
 * How stored trend points become the lines a Trend chart draws. Pure and client-safe: the server builds
 * the lines for the summary and the chart asks the same functions where to mark a change of counting.
 *
 * A point is stored only when something changed (a subscription or Directory point is written only when
 * it differs from the one before), so a quiet day has no row of its own. The lines here fill those days
 * from the category's last point and never store the fill. Each category's line starts at its own first
 * point; the all-categories aggregate starts only on the first day every category has a count, so it
 * never sums a different set of rules on different days.
 */
import { formulasComparable, type TrendLevel } from './trend-version-equality';
import { posturePct } from './posture-math';

/** The columns of a stored point a line reads. */
export interface StoredTrendPoint {
  category: string;
  date: string;
  passingRules: number;
  totalRules: number;
  activeFindings: number;
  formulaVersion: number;
}

/** One day of one category's line. A carried point repeats its source's counts and keeps its version. */
export interface TrendPoint {
  date: string;
  pct: number | null;
  findings: number;
  passing: number;
  total: number;
  formulaVersion: number;
  carried: boolean;
}

/** One day of the all-categories line. */
export interface AggregateTrendPoint {
  date: string;
  pct: number | null;
  findings: number;
  passing: number;
  total: number;
}

function nextDay(dateKey: string): string {
  return new Date(new Date(`${dateKey}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
}

/**
 * Each category's line from `fromDay` to `toDay` (date keys, inclusive), one point per day. A day with
 * no stored point takes the category's newest point before it, including one older than `fromDay`
 * (which the caller passes in `points` for exactly this). A category with no point on or before
 * `fromDay` starts at its first point; one with none at all has no line.
 */
export function trendLines(points: readonly StoredTrendPoint[], fromDay: string, toDay: string): Record<string, TrendPoint[]> {
  const byCategory = new Map<string, StoredTrendPoint[]>();
  for (const p of points) {
    const list = byCategory.get(p.category) ?? [];
    list.push(p);
    byCategory.set(p.category, list);
  }

  const lines: Record<string, TrendPoint[]> = {};
  for (const [category, list] of byCategory) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    const last = list[list.length - 1]!.date;
    const end = last > toDay ? last : toDay;
    let day = list[0]!.date > fromDay ? list[0]!.date : fromDay;
    let i = 0;
    const line: TrendPoint[] = [];
    for (; day <= end; day = nextDay(day)) {
      while (i + 1 < list.length && list[i + 1]!.date <= day) i++;
      const source = list[i]!;
      line.push({
        date: day,
        pct: posturePct(source.passingRules, source.totalRules),
        findings: source.activeFindings,
        passing: source.passingRules,
        total: source.totalRules,
        formulaVersion: source.formulaVersion,
        carried: source.date !== day,
      });
    }
    lines[category] = line;
  }
  return lines;
}

/**
 * The line over all of `categories` together: the sum of their counts on each day, starting on the first
 * day every one of them has a count. Empty when any of them has no line at all.
 */
export function aggregateLine(lines: Record<string, TrendPoint[]>, categories: readonly string[]): AggregateTrendPoint[] {
  if (categories.length === 0 || categories.some(c => !lines[c]?.length)) return [];
  const start = categories.reduce((max, c) => (lines[c]![0]!.date > max ? lines[c]![0]!.date : max), '');
  const byDate = new Map<string, { passing: number; total: number; findings: number }>();
  for (const c of categories) {
    for (const p of lines[c]!) {
      if (p.date < start) continue;
      const e = byDate.get(p.date) ?? { passing: 0, total: 0, findings: 0 };
      e.passing += p.passing;
      e.total += p.total;
      e.findings += p.findings;
      byDate.set(p.date, e);
    }
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, e]) => ({ date, pct: posturePct(e.passing, e.total), findings: e.findings, passing: e.passing, total: e.total }));
}

/**
 * The dates a line's counting changed: the first day of each run of points the version-equality table
 * does not count equal to the run before it, across every line, each date once and in order. A chart
 * draws a marker on each, and the widget says "Counted differently before <date>".
 */
export function trendMarkerDates(level: TrendLevel, lines: Record<string, readonly TrendPoint[]>): string[] {
  const dates = new Set<string>();
  for (const line of Object.values(lines)) {
    for (let i = 1; i < line.length; i++) {
      if (!formulasComparable(level, line[i - 1]!.formulaVersion, line[i]!.formulaVersion)) dates.add(line[i]!.date);
    }
  }
  return [...dates].sort();
}
