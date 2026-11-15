/**
 * The Trend widget: a neutral marker on the day a line's counting changed (and none on an install-wide
 * line across formula 2 to 3), the per-category total caveat gone, its notes sent to the frame, the known
 * reasons as full-tile statuses, and the empty-state copy. Rendered to markup with the chart given a fixed
 * size, since a responsive container measures nothing on a server.
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WidgetSummary } from '@/lib/dashboard-data';
import { TrendWidget } from '@/components/dashboard/widgets/trend-widget';
import { trendUnavailableMessage } from '@/lib/trend-scope';
import { PER_CATEGORY_TOTAL_NOTE, TREND_EMPTY_STATE, TREND_FILTER_TITLE, WIDGET_LIMITS } from '@/lib/widget-limits';

let summary: WidgetSummary | null = null;

// The chart library draws nothing on a server, so each chart part becomes a plain element carrying the props
// the widget gave it: what is asserted is which lines and series the widget asks for, and in what stroke.
vi.mock('recharts', () => {
  const frame = (kind: string) => function Frame({ children }: { children?: ReactNode }) { return createElement('div', { 'data-chart': kind }, children); };
  const part = (kind: string) => function Part(props: Record<string, unknown>) {
    return createElement('i', { 'data-part': kind, 'data-x': props.x as string, 'data-stroke': props.stroke as string, 'data-key': props.dataKey as string });
  };
  return {
    ResponsiveContainer: frame('container'),
    AreaChart: frame('area'), LineChart: frame('line'), BarChart: frame('bar'),
    Area: part('series'), Line: part('series'), Bar: part('series'),
    ReferenceLine: part('marker'),
    XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null, Legend: () => null,
  };
});
vi.mock('@/lib/hooks/use-widget-fetch', () => ({
  useWidgetFetch: () => ({ data: summary, loading: false, failed: false, retry: () => undefined }),
}));

const point = (date: string, formulaVersion: number, carried = false) =>
  ({ date, pct: 50, findings: 3, passing: 1, total: 2, formulaVersion, carried });
const line = (...versions: number[]) => versions.map((v, i) => point(`2026-06-0${i + 1}`, v));

function summaryOf(over: Partial<WidgetSummary>): WidgetSummary {
  return {
    current: { pct: 50, passingRules: 1, totalRules: 2, unknownRules: 0, activityRuleCount: 0, activeFindings: 3, severityCounts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, newInWindow: 0, fixedInWindow: 0 },
    deltaFindings: 0, perCategory: [], perSubscription: [], newVsFixedTrend: [], activityTrend: [], lastScanAt: null,
    baseline: null, deltaPct: null, baselineGap: null, trendIsCategoryScopedOnly: false, trendUnavailable: null,
    trend: [], trendNotes: [], trendLevel: 'install',
    ...over,
  } as unknown as WidgetSummary;
}

const render = (subscriptions?: string[], chartType?: string) => renderToStaticMarkup(createElement(TrendWidget, {
  config: { category: 'security', ...(chartType ? { chartType } : {}) },
  filters: { categories: ['security'], ...(subscriptions ? { subscriptions } : {}), dateWindow: { mode: 'relative', days: 7 } },
  refreshKey: 0,
}));
const markersIn = (html: string) => [...html.matchAll(/<i data-part="marker"[^>]*>/g)].map(m => m[0]);
const markerCount = (html: string) => markersIn(html).length;

beforeEach(() => { summary = null; });

describe('markers', () => {
  const lines = (...versions: number[]) => ({ trend: line(...versions), trendByCategory: { security: line(...versions) } });

  it('draws the chart at all, so the marker tests can fail', () => {
    summary = summaryOf(lines(3, 3, 3));
    expect(render()).toContain('data-part="series"');
  });

  it('draws no marker on an install-wide line across formula 2 to 3', () => {
    summary = summaryOf({ ...lines(2, 2, 3, 3), trendLevel: 'install' });
    expect(markerCount(render())).toBe(0);
  });

  it('draws a marker on a subscription line across the same boundary', () => {
    summary = summaryOf({ ...lines(2, 2, 3, 3), trendLevel: 'subscription' });
    const html = render([SUB]);
    expect(markersIn(html)).toEqual(['<i data-part="marker" data-x="2026-06-03" data-stroke="var(--color-ink-faint)">']);
  });

  it.each(['line', 'bar'])('draws the marker in a %s chart too', chartType => {
    summary = summaryOf({ ...lines(2, 2, 3, 3), trendLevel: 'subscription' });
    expect(markerCount(render([SUB], chartType))).toBe(1);
  });

  it('draws a marker on a Directory line, and a date only once when two categories change on it', () => {
    summary = summaryOf({ trendLevel: 'directory', trend: line(2, 3), trendByCategory: { security: line(2, 3), cost: line(2, 3) } });
    expect(markerCount(render())).toBe(1);
  });

  it('marks a formula 1 line leaving it, even install-wide', () => {
    summary = summaryOf({ ...lines(1, 2), trendLevel: 'install' });
    expect(markerCount(render())).toBe(1);
  });
});

const SUB = '00000000-0000-0000-0000-000000000001';

describe('the per-category total caveat', () => {
  it('is gone from a single-subscription trend, whose limit is W2 in the notes', () => {
    summary = summaryOf({ trend: line(3, 3), trendByCategory: { security: line(3, 3) }, trendLevel: 'subscription', trendNotes: [WIDGET_LIMITS.w2] });
    const html = render([SUB]);
    expect(html).not.toContain(PER_CATEGORY_TOTAL_NOTE);
    expect(html).not.toContain(WIDGET_LIMITS.w2);
  });
});

describe('what the widget says when there is no line', () => {
  it('says why a point has not been written yet', () => {
    summary = summaryOf({ trend: [], trendByCategory: {} });
    expect(render()).toContain('No trend points at this level yet. RuleBeat writes the first one when it next starts or when a rule, suppression or scan changes it.');
    expect(TREND_EMPTY_STATE).toContain('No trend points at this level yet.');
    expect(render()).not.toContain('No trend data yet');
  });

  it('gives a filter the trend is not kept for as a full-tile status with W4 as the detail, and no Retry', () => {
    summary = summaryOf({ trendIsCategoryScopedOnly: true });
    const html = render();
    expect(html).toContain('role="status"');
    expect(html).toContain(TREND_FILTER_TITLE);
    expect(html).toContain(WIDGET_LIMITS.w4.replace(/'/g, '&#x27;'));
    expect(html).not.toContain('Retry');
  });

  it('gives each reason a person can be refused with the title naming the subscription and the Directory', () => {
    for (const reason of ['no-whole-subscription', 'choose-subscription'] as const) {
      summary = summaryOf({ trendUnavailable: reason });
      const html = render();
      const message = trendUnavailableMessage(reason);
      expect(html).toContain('role="status"');
      expect(html).toContain('Trend history is kept per subscription and the Directory');
      expect(html).toContain(message.detail.replace(/'/g, '&#x27;'));
      expect(html).not.toContain('Retry');
    }
  });
});
