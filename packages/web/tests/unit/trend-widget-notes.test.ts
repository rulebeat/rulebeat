/**
 * The Trend widget's notes reach its frame through the real notes hook and the grid's provider: W2 on a
 * single-subscription trend, and "Counted differently before <date>" once for each distinct day, gone when
 * the server stops sending them. Only the summary fetch and the chart library are replaced.
 */
import { act, createElement, type ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WidgetSummary } from '@/lib/dashboard-data';
import type { WidgetDef } from '@/lib/types';
import { WIDGET_LIMITS } from '@/lib/widget-limits';
import { installMiniDom, textOf, withAttribute } from '../helpers/mini-dom';

let summary: WidgetSummary | null = null;

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }) }));
vi.mock('@/lib/hooks/use-widget-fetch', () => ({
  useWidgetFetch: () => ({ data: summary, loading: false, failed: false, retry: () => undefined }),
}));
vi.mock('recharts', () => {
  const frame = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  const none = () => null;
  return {
    ResponsiveContainer: frame, AreaChart: frame, LineChart: frame, BarChart: frame,
    Area: none, Line: none, Bar: none, ReferenceLine: none, XAxis: none, YAxis: none, CartesianGrid: none, Tooltip: none, Legend: none,
  };
});

const point = (date: string, formulaVersion: number) => ({ date, pct: 50, findings: 3, passing: 1, total: 2, formulaVersion, carried: false });
const withNotes = (trendNotes: string[]) => ({
  trend: [point('2026-06-01', 2), point('2026-06-02', 3)], trendByCategory: { security: [point('2026-06-01', 2), point('2026-06-02', 3)] },
  trendLevel: 'subscription', trendNotes, perCategory: [], trendIsCategoryScopedOnly: false, trendUnavailable: null,
}) as unknown as WidgetSummary;

const widget = { id: 'w1', type: 'trend', title: 'Trend', config: { category: 'security' }, x: 0, y: 0, w: 6, h: 4 } as unknown as WidgetDef;
const filters = { categories: ['security'], dateWindow: { mode: 'relative', days: 7 } } as never;

let mini: ReturnType<typeof installMiniDom>;
let mount: (ui: ReturnType<typeof createElement>) => { root: { render(ui: unknown): void }; container: ReturnType<ReturnType<typeof installMiniDom>['container']> };
let WidgetRenderer: typeof import('@/app/(app)/dashboards/[id]/dashboard-grid-client').WidgetRenderer;

beforeAll(async () => {
  mini = installMiniDom();
  const { createRoot } = await import('react-dom/client');
  mount = ui => {
    const container = mini.container();
    const root = createRoot(container as never);
    act(() => root.render(ui));
    return { root, container };
  };
  ({ WidgetRenderer } = await import('@/app/(app)/dashboards/[id]/dashboard-grid-client'));
});

afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.document;
  delete g.window;
  delete g.HTMLIFrameElement;
  delete g.IS_REACT_ACT_ENVIRONMENT;
});

beforeEach(() => { summary = null; });

const frame = () => createElement(WidgetRenderer, {
  widget, filters, filtered: false, refreshKey: 0, editMode: false,
  outsideAccess: { subscriptions: [], resourceGroups: [] }, onRemove: () => undefined, onConfigure: () => undefined,
});
const notesIn = (container: Parameters<typeof withAttribute>[0]) => withAttribute(container, 'data-widget-notes').map(textOf);

describe('the Trend widget\'s notes in its frame', () => {
  it('shows W2 and each distinct day of changed counting once, from what the server sent', () => {
    const sent = [WIDGET_LIMITS.w2, WIDGET_LIMITS.w5('2026-06-02')];
    summary = withNotes(sent);
    const { container } = mount(frame());
    expect(notesIn(container)).toEqual([sent.join('')]);
    expect(textOf(container)).toContain('Counted differently before 2026-06-02.');
  });

  it('takes the notes away when the server stops sending them', () => {
    summary = withNotes([WIDGET_LIMITS.w2]);
    const { root, container } = mount(frame());
    expect(notesIn(container)).toHaveLength(1);

    summary = withNotes([]);
    act(() => root.render(frame()));
    expect(notesIn(container)).toEqual([]);
  });
});
