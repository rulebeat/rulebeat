/**
 * Net change is labelled as a count of findings on the Open findings Stat Card, and the widgets that
 * count New and Fixed state that a finding opened and fixed inside the window counts only as Fixed.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WidgetSummary } from '@/lib/dashboard-data';
import { StatCardWidget } from '@/components/dashboard/widgets/stat-card-widget';
import { NewVsFixedWidget } from '@/components/dashboard/widgets/new-vs-fixed-widget';
import { NEW_FIXED_DEFINITION, netChangeLabel } from '@/lib/widget-limits';

const reported: string[][] = [];

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }));
vi.mock('@/lib/hooks/use-widget-notes', () => ({ useReportWidgetNotes: (notes: string[]) => { reported.push(notes); } }));
vi.mock('@/lib/hooks/use-widget-fetch', () => ({
  useWidgetFetch: () => ({
    data: {
      current: {
        pct: 50, passingRules: 1, totalRules: 2, unknownRules: 0, activityRuleCount: 0,
        activeFindings: 4, severityCounts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, newInWindow: 1, fixedInWindow: 3,
      },
      deltaFindings: -2, perCategory: [], newVsFixedTrend: [], activityTrend: [], postureNotes: ['posture note'],
    } as unknown as WidgetSummary,
    loading: false, failed: false, retry: () => undefined,
  }),
}));

const filters = { dateWindow: { mode: 'relative' as const, days: 7 } };

beforeEach(() => { reported.length = 0; });

describe('netChangeLabel', () => {
  it('reads a signed count of findings', () => {
    expect(netChangeLabel(-2)).toBe('net change −2 findings');
    expect(netChangeLabel(3)).toBe('net change +3 findings');
    expect(netChangeLabel(1)).toBe('net change +1 finding');
    expect(netChangeLabel(0)).toBe('net change 0 findings');
  });
});

describe('the Open findings Stat Card', () => {
  it('shows New, Fixed and Net change as counts of findings', () => {
    const html = renderToStaticMarkup(createElement(StatCardWidget, { config: { metric: 'total-findings' }, filters, refreshKey: 0 }));
    expect(html).toContain('1 new');
    expect(html).toContain('3 fixed');
    expect(html).toContain('net change −2 findings');
  });

  it.each(['total-findings', 'new-findings', 'fixed-findings'] as const)('states the New and Fixed definition on %s', metric => {
    renderToStaticMarkup(createElement(StatCardWidget, { config: { metric }, filters, refreshKey: 0 }));
    expect(reported.at(-1)).toContain(NEW_FIXED_DEFINITION);
  });

  it('does not state it on the posture metric', () => {
    renderToStaticMarkup(createElement(StatCardWidget, { config: { metric: 'posture-pct' }, filters, refreshKey: 0 }));
    expect(reported.at(-1)).not.toContain(NEW_FIXED_DEFINITION);
    expect(reported.at(-1)).toContain('posture note');
  });
});

describe('the New vs Fixed widget', () => {
  it('states the New and Fixed definition', () => {
    renderToStaticMarkup(createElement(NewVsFixedWidget, { config: {}, filters, refreshKey: 0 }));
    expect(reported.at(-1)).toEqual([NEW_FIXED_DEFINITION]);
  });
});
