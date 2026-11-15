/**
 * How stored points become drawn lines: carried across quiet days, each line starting at its own first
 * point, the aggregate starting only when every category has one, and a marker wherever the version-
 * equality table says the counting changed.
 */
import { describe, expect, it } from 'vitest';
import { aggregateLine, trendLines, trendMarkerDates, type StoredTrendPoint } from '@/lib/trend-points';
import { formulasComparable } from '@/lib/trend-version-equality';

const point = (category: string, date: string, passing: number, total: number, formulaVersion = 3, activeFindings = 0): StoredTrendPoint =>
  ({ category, date, passingRules: passing, totalRules: total, activeFindings, formulaVersion });

describe('trendLines', () => {
  it('keeps a category in the line on a day it has no point, from its last point', () => {
    const lines = trendLines([point('security', '2026-06-01', 1, 2), point('security', '2026-06-04', 2, 2), point('cost', '2026-06-01', 3, 4), point('cost', '2026-06-02', 3, 4), point('cost', '2026-06-03', 3, 4), point('cost', '2026-06-04', 3, 4)], '2026-06-01', '2026-06-04');
    expect(lines.security!.map(p => [p.date, p.passing, p.carried])).toEqual([
      ['2026-06-01', 1, false], ['2026-06-02', 1, true], ['2026-06-03', 1, true], ['2026-06-04', 2, false],
    ]);
  });

  it('starts the window with the point from before it, and keeps that point\'s version', () => {
    const lines = trendLines([point('security', '2026-05-20', 1, 2, 2), point('security', '2026-06-03', 2, 2, 3)], '2026-06-01', '2026-06-04');
    expect(lines.security!.map(p => [p.date, p.passing, p.formulaVersion, p.carried])).toEqual([
      ['2026-06-01', 1, 2, true], ['2026-06-02', 1, 2, true], ['2026-06-03', 2, 3, false], ['2026-06-04', 2, 3, true],
    ]);
  });

  it('carries the newest of several points before the window, not the first', () => {
    const lines = trendLines([point('security', '2026-05-20', 1, 4), point('security', '2026-05-25', 3, 4)], '2026-06-01', '2026-06-02');
    expect(lines.security!.map(p => [p.date, p.passing])).toEqual([['2026-06-01', 3], ['2026-06-02', 3]]);
  });

  it('starts a category with no earlier point on its own first point', () => {
    const lines = trendLines([point('security', '2026-06-03', 1, 2)], '2026-06-01', '2026-06-04');
    expect(lines.security!.map(p => p.date)).toEqual(['2026-06-03', '2026-06-04']);
  });

  it('carries to the last day asked for, and gives a category with no point no line', () => {
    const lines = trendLines([point('security', '2026-06-01', 1, 2)], '2026-06-01', '2026-06-03');
    expect(lines.security).toHaveLength(3);
    expect(lines.cost).toBeUndefined();
  });

  it('reads the percentage from passing and total', () => {
    const [first] = trendLines([point('security', '2026-06-01', 239, 240)], '2026-06-01', '2026-06-01').security!;
    expect(first!.pct).toBe(99);
  });
});

describe('aggregateLine', () => {
  const lines = trendLines([
    point('security', '2026-06-01', 1, 2, 3, 4), point('cost', '2026-06-03', 3, 4, 3, 1),
  ], '2026-06-01', '2026-06-04');

  it('starts on the first day every category has a count, summing the carried counts', () => {
    expect(aggregateLine(lines, ['security', 'cost']).map(p => [p.date, p.passing, p.total, p.findings])).toEqual([
      ['2026-06-03', 4, 6, 5], ['2026-06-04', 4, 6, 5],
    ]);
  });

  it('is empty when a category has no line, and for no categories', () => {
    expect(aggregateLine(lines, ['security', 'identity'])).toEqual([]);
    expect(aggregateLine(lines, [])).toEqual([]);
  });

  it('sums only the categories asked for', () => {
    expect(aggregateLine(lines, ['security']).map(p => p.date)).toEqual(['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04']);
  });
});

describe('trendMarkerDates', () => {
  const across = (version: number) => trendLines([point('security', '2026-06-01', 1, 2, 2), point('security', '2026-06-03', 1, 2, version)], '2026-06-01', '2026-06-04');

  it('marks no day on an install-wide line across formula 2 to 3', () => {
    expect(trendMarkerDates('install', across(3))).toEqual([]);
  });

  it('marks the first day of formula 3 on a subscription line and on the Directory', () => {
    expect(trendMarkerDates('subscription', across(3))).toEqual(['2026-06-03']);
    expect(trendMarkerDates('directory', across(3))).toEqual(['2026-06-03']);
  });

  it('marks an install-wide line leaving formula 1', () => {
    const lines = trendLines([point('security', '2026-06-01', 1, 2, 1), point('security', '2026-06-02', 1, 2, 2)], '2026-06-01', '2026-06-02');
    expect(trendMarkerDates('install', lines)).toEqual(['2026-06-02']);
  });

  it('marks nothing across two points of the same version, even one that equals nothing', () => {
    const lines = trendLines([point('security', '2026-06-01', 1, 2, 1), point('security', '2026-06-02', 1, 2, 1)], '2026-06-01', '2026-06-02');
    expect(trendMarkerDates('install', lines)).toEqual([]);
    expect(formulasComparable('subscription', 2, 2)).toBe(true);
  });

  it('draws a date once when several categories change on it, in order', () => {
    const lines = trendLines([
      point('security', '2026-06-01', 1, 2, 2), point('security', '2026-06-03', 1, 2, 3),
      point('cost', '2026-06-01', 1, 2, 2), point('cost', '2026-06-03', 1, 2, 3),
      point('identity', '2026-06-01', 1, 2, 2), point('identity', '2026-06-02', 1, 2, 3),
    ], '2026-06-01', '2026-06-04');
    expect(trendMarkerDates('subscription', lines)).toEqual(['2026-06-02', '2026-06-03']);
  });
});
