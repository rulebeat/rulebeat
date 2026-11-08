/**
 * What a dashboard widget sends to the server (ADR 0013): ids and filter changes, never assembled
 * filters, and a draft with its limit and trend length only while the widget is being previewed.
 */
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WidgetRequestProvider, useWidgetUrl, type WidgetRequestScope } from '@/components/dashboard/widget-request';
import { dashboardAddress } from '@/lib/finding-view';
import { dashboardFiltersOf, differencesFromSaved, savedFiltersOf } from '@/lib/dashboard-filters';

function urlFor(scope: WidgetRequestScope, settings: { limit?: number; trendDays?: number }): string {
  let url = '';
  function Probe() { url = useWidgetUrl('top-rules', settings); return null; }
  renderToString(createElement(WidgetRequestProvider, { value: scope }, createElement(Probe)));
  return url;
}

describe('the URL a widget asks for', () => {
  const scope: WidgetRequestScope = { dashboardId: 'd1', widgetId: 'w1', changes: 'severity=high' };

  it('names the dashboard, the widget and the filter changes', () => {
    const params = new URL(urlFor(scope, { limit: 5 }), 'http://localhost').searchParams;
    expect(Object.fromEntries(params)).toEqual({ dashboard: 'd1', widget: 'w1', severity: 'high' });
  });

  it('adds the draft, the limit and the trend length only in a preview', () => {
    const preview = { ...scope, preview: { config: { limit: 7 } } };
    const params = new URL(urlFor(preview, { limit: 7, trendDays: 90 }), 'http://localhost').searchParams;
    expect(params.get('preview')).toBe('1');
    expect(JSON.parse(params.get('draft')!)).toEqual({ limit: 7 });
    expect([params.get('limit'), params.get('trendDays')]).toEqual(['7', '90']);
  });

  it('is built under /api/widgets for the route it names', () => {
    expect(urlFor(scope, {}).startsWith('/api/widgets/top-rules?')).toBe(true);
  });
});

describe('the filter changes a dashboard sends', () => {
  const config = { widgets: [], filters: { subscriptions: ['sub-1'], categories: ['security'] }, dateWindow: { mode: 'relative' as const, days: 30 } };
  const saved = savedFiltersOf(config);
  const bar = (over: Partial<Parameters<typeof dashboardFiltersOf>[0]> = {}) => dashboardFiltersOf({
    categories: ['security'], subscriptions: ['sub-1'], resourceGroups: [], tags: [], severities: [], ruleIds: [], ...over,
  }, { mode: 'relative', days: 30 });

  it('are empty while the filter bar holds what the dashboard saved', () => {
    expect(differencesFromSaved(saved, bar())).toEqual({});
    expect(dashboardAddress(saved).write(differencesFromSaved(saved, bar())).toString()).toBe('');
  });

  it('name only the dimension the bar changed, and an emptied one as any', () => {
    const changes = differencesFromSaved(saved, bar({ severities: ['high'], categories: [] }));
    expect(dashboardAddress(saved).write(changes).toString()).toBe('category=&severity=high');
  });
});
