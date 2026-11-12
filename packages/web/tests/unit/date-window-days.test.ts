/**
 * A relative window of N days is exactly N UTC day keys: today and the N-1 days before it. The
 * shortest window reads "Today (UTC)", and a stored period on a chart widget is its own window.
 */
import { describe, expect, it } from 'vitest';
import { dateWindowLabel, dateWindowPhrase, resolveDateWindow } from '@/lib/date-window';
import { mergeWidgetFilters, parseWidgetFiltersFromSearchParams, periodWindowDays, type WidgetFilters } from '@/lib/dashboard-filters';

const NOW = new Date('2026-06-15T10:30:00.000Z');

/** Every day key the resolved window holds, inclusive at both ends. */
function dayKeys(from: string, to: string): string[] {
  const keys: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) keys.push(d.toISOString().slice(0, 10));
  return keys;
}

describe('a relative window of N days', () => {
  it('holds exactly 7 day keys for 7 days, ending today', () => {
    const { from, to } = resolveDateWindow({ mode: 'relative', days: 7 }, NOW);
    expect(to).toBe('2026-06-15');
    expect(dayKeys(from, to)).toEqual([
      '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13', '2026-06-14', '2026-06-15',
    ]);
  });

  it('holds exactly one day key for 1 day, today', () => {
    expect(resolveDateWindow({ mode: 'relative', days: 1 }, NOW)).toEqual({ from: '2026-06-15', to: '2026-06-15' });
  });

  it('holds exactly 30 day keys for 30 days', () => {
    const { from, to } = resolveDateWindow({ mode: 'relative', days: 30 }, NOW);
    expect(dayKeys(from, to)).toHaveLength(30);
  });

  it('keeps resolving a stored window of 1 and ?window=1', () => {
    expect(resolveDateWindow({ mode: 'relative', days: 1 }, NOW).from).toBe('2026-06-15');
    const parsed = parseWidgetFiltersFromSearchParams(new URLSearchParams('window=1'));
    expect(parsed.dateWindow).toEqual({ mode: 'relative', days: 1 });
  });

  it('leaves a custom range as whole UTC days, inclusive, clamped to today', () => {
    expect(resolveDateWindow({ mode: 'custom', from: '2026-06-01', to: '2026-06-03' }, NOW)).toEqual({ from: '2026-06-01', to: '2026-06-03' });
    expect(resolveDateWindow({ mode: 'custom', from: '2026-06-10', to: '2099-01-01' }, NOW)).toEqual({ from: '2026-06-10', to: '2026-06-15' });
  });
});

describe('the relative labels', () => {
  it('names the one-day window Today (UTC) and keeps the others', () => {
    expect(dateWindowLabel({ mode: 'relative', days: 1 })).toBe('Today (UTC)');
    expect(dateWindowLabel({ mode: 'relative', days: 7 })).toBe('7d');
    expect(dateWindowLabel({ mode: 'relative', days: 30 })).toBe('30d');
  });

  it('reads as a sentence for the one-day window', () => {
    expect(dateWindowPhrase({ mode: 'relative', days: 1 })).toBe('today (UTC)');
    expect(dateWindowPhrase({ mode: 'relative', days: 7 })).toBe('in the last 7d');
  });
});

describe('a stored widget period', () => {
  const dashboard: WidgetFilters = { dateWindow: { mode: 'relative', days: 7 } };

  it('reads Nd as N days', () => {
    expect(periodWindowDays('30d', 365)).toBe(30);
    expect(periodWindowDays('90d', 180)).toBe(90);
    expect(periodWindowDays('7d', 365)).toBe(7);
  });

  it("reads 'all' as the widget's own retention", () => {
    expect(periodWindowDays('all', 365)).toBe(365);
    expect(periodWindowDays('all', 180)).toBe(180);
  });

  it('reads an unreadable value as nothing', () => {
    expect(periodWindowDays('fortnight', 365)).toBeNull();
    expect(periodWindowDays('0d', 365)).toBeNull();
    expect(periodWindowDays(undefined, 365)).toBeNull();
    expect(periodWindowDays(30, 365)).toBeNull();
  });

  it("becomes the widget's date window, in place of the dashboard's", () => {
    expect(mergeWidgetFilters(dashboard, { period: '30d' }, { periodAllDays: 365 }).dateWindow).toEqual({ mode: 'relative', days: 30 });
    expect(mergeWidgetFilters(dashboard, { period: 'all' }, { periodAllDays: 180 }).dateWindow).toEqual({ mode: 'relative', days: 180 });
  });

  it("falls back to the dashboard's window when it cannot be read", () => {
    expect(mergeWidgetFilters(dashboard, { period: 'fortnight' }, { periodAllDays: 365 }).dateWindow).toEqual(dashboard.dateWindow);
  });

  it("is ignored by a widget that does not read a period", () => {
    expect(mergeWidgetFilters(dashboard, { period: '30d' }).dateWindow).toEqual(dashboard.dateWindow);
  });

  it("yields to the widget's explicit window override", () => {
    expect(mergeWidgetFilters(dashboard, { period: '30d', windowDays: 1 }, { periodAllDays: 365 }).dateWindow).toEqual({ mode: 'relative', days: 1 });
  });
});
