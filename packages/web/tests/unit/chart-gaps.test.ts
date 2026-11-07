import { describe, it, expect } from 'vitest';
import { GAP_REASON_TEXT, countRows, daysBetween, trendDays, trendRows, type TrendPoint } from '@/lib/chart-gaps';

const point = (date: string, pct: number | null, extra: Partial<TrendPoint> = {}): TrendPoint =>
  ({ date, pct, passing: pct ?? 0, total: 100, ...extra });

describe('daysBetween', () => {
  it('lists every day inclusive, across a month end', () => {
    expect(daysBetween('2026-01-30', '2026-02-02')).toEqual(['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
  });
});

describe('trendDays', () => {
  it('starts at the first record when it is inside the window and runs to today', () => {
    expect(trendDays(['2026-03-03', '2026-03-05'], 30, '2026-03-07')).toEqual(
      ['2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07'],
    );
  });
  it('starts at the window start when the first record is older', () => {
    expect(trendDays(['2026-01-01'], 2, '2026-03-07')).toEqual(['2026-03-05', '2026-03-06', '2026-03-07']);
  });
  it('is empty when nothing was ever recorded', () => {
    expect(trendDays([], 30, '2026-03-07')).toEqual([]);
  });
});

describe('trendRows', () => {
  const days = ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04'];

  it('leaves a day with no record empty with its reason, never carrying the last value', () => {
    const rows = trendRows(days, { pct: [point('2026-03-01', 80), point('2026-03-04', 70)] });
    expect(rows.map(r => r.pct)).toEqual([80, null, null, 70]);
    expect(rows[1]!.pct__gap).toBe('no-record');
    expect(GAP_REASON_TEXT[rows[1]!.pct__gap as 'no-record']).toBe('No record for this day');
  });

  it('keeps a recorded zero as 0, not as a gap', () => {
    const rows = trendRows(days, { pct: [point('2026-03-02', 0)] });
    expect(rows[1]!.pct).toBe(0);
    expect(rows[1]!.pct__gap).toBeNull();
    expect(rows[0]!.pct).toBeNull();
  });

  it('names the earlier posture formula as the reason for a day recorded under it', () => {
    const rows = trendRows(days, { pct: [point('2026-03-02', 55, { earlierFormula: true })] });
    expect(rows[1]!.pct).toBeNull();
    expect(rows[1]!.pct__gap).toBe('earlier-formula');
    expect(GAP_REASON_TEXT['earlier-formula']).toBe('Recorded under an earlier posture formula');
  });

  it('flags only a point with a gap on both sides as lone', () => {
    const rows = trendRows(days, { pct: [point('2026-03-01', 10), point('2026-03-02', 20), point('2026-03-04', 40)] });
    expect(rows.map(r => r.pct__lone)).toEqual([false, false, false, true]);
  });

  it('treats a lone first or last day as lone, and a single-day series as lone', () => {
    const rows = trendRows(['2026-03-01'], { pct: [point('2026-03-01', 90)] });
    expect(rows[0]!.pct__lone).toBe(true);
  });

  it('carries each series\' own counts and gaps', () => {
    const rows = trendRows(days, {
      cost: [point('2026-03-01', 50, { passing: 5, total: 10 })],
      security: [point('2026-03-02', 60)],
    });
    expect(rows[0]).toMatchObject({ cost: 50, cost__passing: 5, cost__total: 10, security: null, security__gap: 'no-record' });
    expect(rows[1]).toMatchObject({ cost: null, security: 60 });
  });
});

describe('countRows', () => {
  const counts = [
    { date: '2026-03-01', created: 3, resolved: 1 },
    { date: '2026-03-02', created: 0, resolved: 0 },
    { date: '2026-03-03', created: 0, resolved: 0 },
  ];

  it('draws a day with no record as a gap and a recorded zero day as zeros', () => {
    const rows = countRows(counts, ['created', 'resolved'], ['2026-03-01', '2026-03-02']);
    expect(rows[1]).toEqual({ date: '2026-03-02', gap: null, created: 0, resolved: 0 });
    expect(rows[2]).toEqual({ date: '2026-03-03', gap: 'no-record', created: null, resolved: null });
  });

  it('never calls a day with counts a gap', () => {
    const rows = countRows(counts, ['created', 'resolved'], []);
    expect(rows[0]).toMatchObject({ gap: null, created: 3, resolved: 1 });
  });

  it('treats every day as recorded when the server has no record of scan days', () => {
    const rows = countRows(counts, ['created', 'resolved'], null);
    expect(rows.every(r => r.gap === null)).toBe(true);
  });
});
