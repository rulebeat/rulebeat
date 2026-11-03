/**
 * What Present puts on the screen, rendered the way the server renders it (effects do not run, so a client
 * that waits for the browser shows what it shows before the browser answers): the frame's one Exit control,
 * the Full screen button, the read-only grid, the toolbar's Present action, and the two reasons a widget gives
 * that are a live region on the dashboard and plain text on Present.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Dashboard, WidgetDef } from '@/lib/types';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
}));

const { FullScreenButton, PresentFrame, PresentGrid } = await import('@/app/dashboards/[id]/present/present-screen');
const { PresentAction } = await import('@/components/dashboard/present-action');
const { PresentProvider, useChartAnimation } = await import('@/components/dashboard/present-context');
const { WidgetRenderer } = await import('@/components/dashboard/widget-renderer');
const { TrendUnavailable } = await import('@/components/dashboard/widgets/trend-widget');
const { DashboardGridClient } = await import('@/app/(app)/dashboards/[id]/dashboard-grid-client');

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

const widget: WidgetDef = { id: 'w1', type: 'stat-card', title: 'Findings', x: 0, y: 0, w: 4, h: 2, config: { subscriptions: ['sub-hidden'] } };
const dashboard = (widgets: WidgetDef[]): Dashboard => ({
  id: 'd1', name: 'Security posture', config: { widgets }, isDefault: false, createdAt: '2026-01-01T00:00:00.000Z',
});
const FILTERS = { dateWindow: { mode: 'relative', days: 7 } } as const;
const NOTHING = { subscriptions: [], resourceGroups: [] };

describe('the frame', () => {
  const frame = html(createElement(PresentFrame, { name: 'Security posture', exitHref: '/dashboards/d1?window=30', children: createElement('p', null, 'the grid') }));

  it('has one Exit control, and it leads to the ordinary view', () => {
    expect(frame.match(/Exit/g)).toHaveLength(1);
    expect(frame).toContain('href="/dashboards/d1?window=30"');
  });

  it('names the dashboard and holds what it is given in one scroll region', () => {
    expect(frame).toContain('Security posture');
    expect(frame.match(/overflow-y-auto/g)).toHaveLength(1);
    expect(frame).toContain('the grid');
  });

  it('does not offer Full screen before the browser has said it can', () => {
    expect(frame).not.toContain('Full screen');
  });
});

describe('FullScreenButton', () => {
  it('is a button when the browser offers full screen', () => {
    expect(html(createElement(FullScreenButton, { offered: true, onRequest: () => undefined }))).toMatch(/<button[^>]*>.*Full screen/);
  });

  it('renders nothing when it is not offered (unsupported, or already full screen)', () => {
    expect(html(createElement(FullScreenButton, { offered: false, onRequest: () => undefined }))).toBe('');
  });
});

describe('the grid', () => {
  it('says No widgets yet without the button that adds one', () => {
    const empty = html(createElement(PresentGrid, { dashboard: dashboard([]), filters: FILTERS, outsideAccess: NOTHING }));
    expect(empty).toContain('No widgets yet');
    expect(empty).not.toContain('<button');
    expect(empty).not.toContain('Add your first widget');
  });

  it('shows a widget with no configure, remove or drag controls', () => {
    const grid = html(createElement(PresentGrid, { dashboard: dashboard([widget]), filters: FILTERS, outsideAccess: NOTHING }));
    expect(grid).toContain('Findings');
    expect(grid).not.toContain('Configure widget');
    expect(grid).not.toContain('Remove widget');
    expect(grid).not.toContain('widget-drag-handle');
  });
});

describe('the toolbar action', () => {
  it('is on the dashboard\'s toolbar', () => {
    expect(html(createElement(DashboardGridClient, { dashboard: dashboard([widget]), outsideAccess: NOTHING }))).toContain('Present');
  });

  it('is there outside an edit session', () => {
    expect(html(createElement(PresentAction, { dashboardId: 'd1', editMode: false }))).toContain('Present');
  });

  it('is hidden in an edit session', () => {
    expect(html(createElement(PresentAction, { dashboardId: 'd1', editMode: true }))).toBe('');
  });
});

describe('the reasons a widget gives', () => {
  const outside = { subscriptions: ['sub-hidden'], resourceGroups: [] };
  const reason = (presenting: boolean) => {
    const rendered = createElement(WidgetRenderer, { widget, filters: FILTERS, filtered: true, refreshKey: 0, editMode: false, outsideAccess: outside });
    return html(presenting ? createElement(PresentProvider, { value: true }, rendered) : rendered);
  };

  it('keeps the access reason a live region on the dashboard', () => {
    expect(reason(false)).toContain('Outside your access');
    expect(reason(false)).toContain('role="status"');
  });

  it('shows the access reason without role=status on Present', () => {
    expect(reason(true)).toContain('Outside your access');
    expect(reason(true)).not.toContain('role="status"');
  });

  it('does the same for the trend widget\'s empty state', () => {
    const trend = (presenting: boolean) => {
      const rendered = createElement(TrendUnavailable, { reason: 'resource-group' } as never);
      return html(presenting ? createElement(PresentProvider, { value: true }, rendered) : rendered);
    };
    expect(trend(false)).toContain('role="status"');
    expect(trend(true)).not.toContain('role="status"');
    expect(trend(true)).toBe(trend(false).replace(' role="status"', ''));
  });
});

describe('chart animation', () => {
  const Probe = () => createElement('i', null, String(useChartAnimation()));

  it('is on in the ordinary view and off on Present', () => {
    expect(html(createElement(Probe))).toBe('<i>true</i>');
    expect(html(createElement(PresentProvider, { value: true }, createElement(Probe)))).toBe('<i>false</i>');
  });

  it('is read by every chart series a widget draws', () => {
    const dir = join(__dirname, '../../components/dashboard/widgets');
    const files = readdirSync(dir).filter(f => f.endsWith('.tsx')).filter(f => readFileSync(join(dir, f), 'utf8').includes("from 'recharts'"));
    expect(files.length).toBeGreaterThan(4);
    for (const file of files) {
      const source = readFileSync(join(dir, file), 'utf8');
      expect(source, file).toContain('useChartAnimation()');
      // From a series' tag to the next element's, so a sibling's props never stand in for its own.
      const opening = [...source.matchAll(/<(Bar|Line|Area|Pie)\b[\s\S]*?(?=<\/?[A-Z]|$)/g)].map(m => m[0]);
      expect(opening.length, file).toBeGreaterThan(0);
      for (const tag of opening) expect(tag, `${file}: ${tag.slice(0, 40)}`).toContain('isAnimationActive={animate}');
    }
  });
});
