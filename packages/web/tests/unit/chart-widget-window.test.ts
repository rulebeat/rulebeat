/**
 * The date window drives the Trend, New vs Fixed and Activity Occurrences charts. Each widget asks the
 * summary route for its own window (a saved period, else the dashboard's) and sends no `trendDays`, and
 * the window control names the shortest preset Today (UTC). Rendered on the server with the widget fetch
 * hook replaced, so the request each widget makes can be read.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TrendWidget } from '@/components/dashboard/widgets/trend-widget';
import { NewVsFixedWidget } from '@/components/dashboard/widgets/new-vs-fixed-widget';
import { ActivityOccurrencesWidget } from '@/components/dashboard/widgets/activity-occurrences-widget';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import type { WidgetFilters } from '@/lib/dashboard-filters';

const requested: string[] = [];

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }));
vi.mock('@/lib/hooks/use-widget-fetch', () => ({
  useWidgetFetch: (url: string) => {
    requested.push(url);
    return { data: null, loading: true, failed: false, retry: () => undefined };
  },
}));

const dashboard: WidgetFilters = { dateWindow: { mode: 'relative', days: 7 } };

/** The query the widget sent, read as the summary route reads it. */
function queryOf(widget: typeof TrendWidget | typeof NewVsFixedWidget | typeof ActivityOccurrencesWidget, config: Record<string, unknown>): URLSearchParams {
  requested.length = 0;
  renderToStaticMarkup(createElement(widget as typeof TrendWidget, { config, filters: dashboard, refreshKey: 0 }));
  return new URLSearchParams(requested[0]!.split('?')[1]);
}

const WIDGETS = [
  ['Trend', TrendWidget, 365],
  ['New vs Fixed', NewVsFixedWidget, 180],
  ['Activity Occurrences', ActivityOccurrencesWidget, 180],
] as const;

describe.each(WIDGETS)('the %s widget', (_name, widget, allDays) => {
  it("asks for the dashboard's window when it has no saved period, and sends no trendDays", () => {
    const query = queryOf(widget, {});
    expect(query.get('window')).toBe('7');
    expect(query.has('trendDays')).toBe(false);
  });

  it('reads a saved 30d as a 30 day window', () => {
    expect(queryOf(widget, { period: '30d' }).get('window')).toBe('30');
  });

  it("reads a saved 'all' as the days its data is kept", () => {
    expect(queryOf(widget, { period: 'all' }).get('window')).toBe(String(allDays));
  });

  it("falls back to the dashboard's window for a period it cannot read", () => {
    expect(queryOf(widget, { period: 'forever' }).get('window')).toBe('7');
  });
});

describe('the window control', () => {
  it('names the one-day preset Today (UTC)', () => {
    const html = renderToStaticMarkup(createElement(DateRangePicker, { value: { mode: 'relative', days: 1 }, onChange: () => undefined }));
    expect(html).toContain('Today (UTC)');
    expect(html).not.toContain('24h');
  });
});
