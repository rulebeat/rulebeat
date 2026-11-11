/**
 * A widget's limit notes reach its frame through the real notes hook and the grid's real
 * WidgetNotesContext provider: the note shows once the widget's data asks for it, and is gone when the
 * trigger is (the notes the server sends go empty, the data is reloading, or the widget is removed).
 * Mounted with react-dom/client on a minimal DOM, since server rendering never runs effects; only the
 * summary fetch is replaced, by whatever a response would hold.
 */
import { act, createElement } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WidgetSummary } from '@/lib/dashboard-data';
import type { WidgetDef } from '@/lib/types';
import { EVERYONE_LINE, NEW_FIXED_DEFINITION, postureEmptyReason } from '@/lib/widget-limits';
import { installMiniDom, textOf, withAttribute } from '../helpers/mini-dom';

let summary: WidgetSummary | null = null;
let loading = false;

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }) }));
vi.mock('@/lib/hooks/use-widget-fetch', () => ({
  useWidgetFetch: () => ({ data: summary, loading, failed: false, retry: () => undefined }),
}));

const summaryWith = (over: Partial<WidgetSummary> = {}): WidgetSummary => ({
  current: {
    pct: 75, passingRules: 3, totalRules: 4, unknownRules: 1, activityRuleCount: 0,
    activeFindings: 0, severityCounts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, newInWindow: 0, fixedInWindow: 0,
  },
  deltaFindings: 0, postureNotes: [EVERYONE_LINE], measure: null, emptyReason: null,
  perCategory: [], perSubscription: [], newVsFixedTrend: [], activityTrend: [],
  lastScanAt: null, baseline: null, deltaPct: null, baselineGap: null, trend: [], trendIsCategoryScopedOnly: false, trendUnavailable: null,
  ...over,
} as WidgetSummary);

const ringWidget = { id: 'w1', type: 'posture-ring', title: 'Overall posture', config: {}, x: 0, y: 0, w: 3, h: 4 } as unknown as WidgetDef;
const filters = { dateWindow: { mode: 'relative', days: 7 } } as never;

let mini: ReturnType<typeof installMiniDom>;
let mount: (ui: ReturnType<typeof createElement>) => { root: { render(ui: unknown): void; unmount(): void }; container: ReturnType<ReturnType<typeof installMiniDom>['container']> };
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

beforeEach(() => { summary = null; loading = false; });

const frame = (widget: WidgetDef = ringWidget) => createElement(WidgetRenderer, {
  widget, filters, filtered: false, refreshKey: 0, editMode: false,
  outsideAccess: { subscriptions: [], resourceGroups: [] }, onRemove: () => undefined, onConfigure: () => undefined,
});
const notesIn = (container: Parameters<typeof withAttribute>[0]) => withAttribute(container, 'data-widget-notes').map(textOf);

describe('a widget\'s notes in its frame', () => {
  it('shows each note the server sent once the data has arrived, after the widget\'s own content', () => {
    summary = summaryWith({ postureNotes: [EVERYONE_LINE, 'None of the selected rules is counted'] });
    const { container } = mount(frame());
    expect(notesIn(container)).toEqual([EVERYONE_LINE + 'None of the selected rules is counted']);
    expect(textOf(container).indexOf('checks passing')).toBeLessThan(textOf(container).indexOf(EVERYONE_LINE));
  });

  it('shows the notes on a posture figure with nothing to count, beside the reason', () => {
    summary = summaryWith({
      current: { ...summaryWith().current, pct: null, passingRules: 0, totalRules: 0, unknownRules: 0 },
      emptyReason: postureEmptyReason('filter-left-nothing'),
      postureNotes: [EVERYONE_LINE],
    });
    const { container } = mount(frame());
    expect(textOf(container)).toContain('The filter left nothing to count');
    expect(textOf(container)).toContain(EVERYONE_LINE);
  });

  it('takes the note away when the server stops sending it', () => {
    summary = summaryWith();
    const { root, container } = mount(frame());
    expect(notesIn(container)).toHaveLength(1);

    summary = summaryWith({ postureNotes: [] });
    act(() => root.render(frame()));
    expect(notesIn(container)).toEqual([]);
    expect(textOf(container)).not.toContain(EVERYONE_LINE);
  });

  it('replaces one note with another, so a stale note does not stay beside the new one', () => {
    summary = summaryWith({ postureNotes: ['First limit.'] });
    const { root, container } = mount(frame());
    summary = summaryWith({ postureNotes: ['Second limit.'] });
    act(() => root.render(frame()));
    expect(textOf(container)).toContain('Second limit.');
    expect(textOf(container)).not.toContain('First limit.');
  });

  it('takes the note away when the widget goes', () => {
    summary = summaryWith();
    const { root, container } = mount(frame());
    expect(notesIn(container)).toHaveLength(1);

    // The frame outlives the widget it holds: the access reason replaces the ring.
    const outside = { subscriptions: ['11111111-1111-1111-1111-111111111111'], resourceGroups: [] };
    const gone = { ...ringWidget, config: { subscriptions: outside.subscriptions } } as unknown as WidgetDef;
    act(() => root.render(createElement(WidgetRenderer, {
      widget: gone, filters, filtered: true, refreshKey: 0, editMode: false, outsideAccess: outside,
      onRemove: () => undefined, onConfigure: () => undefined,
    })));
    expect(notesIn(container)).toEqual([]);
  });

  it('takes the note away while the stat card reloads, and brings it back with the data', () => {
    summary = summaryWith();
    const widget = { ...ringWidget, type: 'stat-card', config: { metric: 'posture-pct' } } as unknown as WidgetDef;
    const { root, container } = mount(frame(widget));
    expect(notesIn(container)).toHaveLength(1);

    loading = true;
    act(() => root.render(frame(widget)));
    expect(notesIn(container)).toEqual([]);

    loading = false;
    act(() => root.render(frame(widget)));
    expect(notesIn(container)).toHaveLength(1);
  });

  it('shows no note on a stat card metric that does not read the posture formula', () => {
    summary = summaryWith();
    const widget = { ...ringWidget, type: 'stat-card', config: { metric: 'critical-findings' } } as unknown as WidgetDef;
    const { container } = mount(frame(widget));
    expect(notesIn(container)).toEqual([]);
  });

  it('shows only the New and Fixed definition on the stat card that counts them', () => {
    summary = summaryWith();
    const widget = { ...ringWidget, type: 'stat-card', config: { metric: 'total-findings' } } as unknown as WidgetDef;
    const { container } = mount(frame(widget));
    expect(notesIn(container)).toHaveLength(1);
    expect(container.textContent).toContain(NEW_FIXED_DEFINITION);
  });
});
