/**
 * Spec 018 (RB-QA-020) · buildScansHref's category param, and its inverse parseCategoryParam.
 *
 * buildScansHref used to only emit `?category=` when a widget's merged filters carried exactly
 * one category, silently dropping the param the moment a dashboard filter bar selected two or
 * more: the click-through landed on the Results tab scoped to nothing, showing every category's
 * findings instead of just the ones the widget counted. Fixed to comma-join, matching every other
 * multi-value param (`ruleId`, `subscription`, `severity`, `tags`) already on this same function.
 */
import { describe, expect, it } from 'vitest';
import { buildScansHref, newVsFixedBarHref, parseCategoryParam } from '@/lib/scans-link';
import { viewFromSearchParams } from '@/lib/finding-view';
import type { WidgetFilters } from '@/lib/dashboard-filters';

function widgetFilters(overrides: Partial<WidgetFilters> = {}): WidgetFilters {
  return { dateWindow: { mode: 'relative', days: 7 }, ...overrides };
}

describe('buildScansHref · category param', () => {
  it('emits no category param when the filters carry zero categories', async () => {
    const href = buildScansHref(widgetFilters());
    expect(new URLSearchParams(href.split('?')[1]).has('category')).toBe(false);
  });

  it('emits a single category value unjoined', async () => {
    const href = buildScansHref(widgetFilters({ categories: ['security'] }));
    expect(new URLSearchParams(href.split('?')[1]).get('category')).toBe('security');
  });

  it('comma-joins two or more categories', async () => {
    const href = buildScansHref(widgetFilters({ categories: ['security', 'cost', 'identity'] }));
    expect(new URLSearchParams(href.split('?')[1]).get('category')).toBe('security,cost,identity');
  });

  it('a per-widget category override wins over a multi-category dashboard filter', async () => {
    // coverage-freshness-widget.tsx:67 does exactly this. One Link per category row, each
    // overriding to its own single category regardless of how the dashboard filter bar is set.
    const href = buildScansHref(widgetFilters({ categories: ['security', 'cost'] }), { category: 'identity' });
    expect(new URLSearchParams(href.split('?')[1]).get('category')).toBe('identity');
  });
});

describe('buildScansHref · placements override', () => {
  const params = (href: string) => new URLSearchParams(href.split('?')[1]);

  it('writes the generic f= param, with the values joined by a pipe', () => {
    const href = buildScansHref(widgetFilters(), { placements: ['directory', 'management-group'] });
    expect(params(href).getAll('f')).toEqual(['placement=directory|management-group']);
    expect(params(href).has('placement')).toBe(false);
  });

  it('writes nothing when no placement is given', () => {
    expect(params(buildScansHref(widgetFilters())).has('f')).toBe(false);
    expect(params(buildScansHref(widgetFilters(), { placements: [] })).has('f')).toBe(false);
  });

  it('opens a view that filters on the same placements', () => {
    const view = viewFromSearchParams(params(buildScansHref(widgetFilters(), { placements: ['workspace'] })));
    expect(view.filters).toEqual([{ field: 'placement', values: ['workspace'] }]);
  });
});

describe('parseCategoryParam', () => {
  it('returns an empty list for undefined', async () => {
    expect(parseCategoryParam(undefined)).toEqual([]);
  });

  it('treats "all" as no filter, matching the sentinel every other category param uses', async () => {
    expect(parseCategoryParam('all')).toEqual([]);
  });

  it('splits a comma-joined list, dropping empty segments', async () => {
    expect(parseCategoryParam('security,cost,identity')).toEqual(['security', 'cost', 'identity']);
    expect(parseCategoryParam('security,,cost')).toEqual(['security', 'cost']);
  });

  it('round-trips through buildScansHref for 0/1/2+ categories', async () => {
    for (const categories of [[], ['security'], ['security', 'cost']]) {
      const href = buildScansHref(widgetFilters({ categories }));
      const params = new URLSearchParams(href.split('?')[1]);
      expect(parseCategoryParam(params.get('category') ?? undefined)).toEqual(categories);
    }
  });
});

describe('buildScansHref · dateWindow override', () => {
  const params = (href: string) => new URLSearchParams(href.split('?')[1]);

  it('replaces the inherited window with the override', () => {
    const href = buildScansHref(widgetFilters(), { dateWindow: { mode: 'custom', from: '2026-03-04', to: '2026-03-04' } });
    expect(params(href).get('from')).toBe('2026-03-04');
    expect(params(href).get('to')).toBe('2026-03-04');
    expect(params(href).has('window')).toBe(false);
  });

  it("keeps the inherited window when there is no override", () => {
    expect(params(buildScansHref(widgetFilters())).get('window')).toBe('7');
  });
});

describe('newVsFixedBarHref', () => {
  it('opens a one-day list of the bar status under the widget filters', () => {
    const href = newVsFixedBarHref(widgetFilters({ categories: ['security'] }), '2026-03-04', 'fixed');
    const view = viewFromSearchParams(new URLSearchParams(href.split('?')[1]));
    expect(view.window).toEqual({ mode: 'custom', from: '2026-03-04', to: '2026-03-04' });
    expect(view.filters).toEqual(expect.arrayContaining([
      { field: 'status', values: ['fixed'] },
      { field: 'category', values: ['security'] },
    ]));
  });
});
