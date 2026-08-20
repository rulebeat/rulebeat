/**
 * Spec 018 (RB-QA-020) · buildScansHref's category param, and its inverse parseCategoryParam.
 *
 * buildScansHref used to only emit `?category=` when a widget's merged filters carried exactly
 * one category, silently dropping the param the moment a dashboard filter bar selected two or
 * more — the click-through landed on the Results tab scoped to nothing, showing every category's
 * findings instead of just the ones the widget counted. Fixed to comma-join, matching every other
 * multi-value param (`ruleId`, `subscription`, `severity`, `tags`) already on this same function.
 */
import { describe, expect, it } from 'vitest';
import { buildScansHref, parseCategoryParam } from '@/lib/scans-link';
import type { WidgetFilters } from '@/lib/dashboard-filters';

function widgetFilters(overrides: Partial<WidgetFilters> = {}): WidgetFilters {
  return { dateWindow: { mode: 'relative', days: 7 }, ...overrides };
}

describe('buildScansHref · category param', () => {
  it('emits no category param when the filters carry zero categories', () => {
    const href = buildScansHref(widgetFilters());
    expect(new URLSearchParams(href.split('?')[1]).has('category')).toBe(false);
  });

  it('emits a single category value unjoined', () => {
    const href = buildScansHref(widgetFilters({ categories: ['security'] }));
    expect(new URLSearchParams(href.split('?')[1]).get('category')).toBe('security');
  });

  it('comma-joins two or more categories', () => {
    const href = buildScansHref(widgetFilters({ categories: ['security', 'cost', 'identity'] }));
    expect(new URLSearchParams(href.split('?')[1]).get('category')).toBe('security,cost,identity');
  });

  it('a per-widget category override wins over a multi-category dashboard filter', () => {
    // coverage-freshness-widget.tsx:67 does exactly this — one Link per category row, each
    // overriding to its own single category regardless of how the dashboard filter bar is set.
    const href = buildScansHref(widgetFilters({ categories: ['security', 'cost'] }), { category: 'identity' });
    expect(new URLSearchParams(href.split('?')[1]).get('category')).toBe('identity');
  });
});

describe('parseCategoryParam', () => {
  it('returns an empty list for undefined', () => {
    expect(parseCategoryParam(undefined)).toEqual([]);
  });

  it('treats "all" as no filter, matching the sentinel every other category param uses', () => {
    expect(parseCategoryParam('all')).toEqual([]);
  });

  it('splits a comma-joined list, dropping empty segments', () => {
    expect(parseCategoryParam('security,cost,identity')).toEqual(['security', 'cost', 'identity']);
    expect(parseCategoryParam('security,,cost')).toEqual(['security', 'cost']);
  });

  it('round-trips through buildScansHref for 0/1/2+ categories', () => {
    for (const categories of [[], ['security'], ['security', 'cost']]) {
      const href = buildScansHref(widgetFilters({ categories }));
      const params = new URLSearchParams(href.split('?')[1]);
      expect(parseCategoryParam(params.get('category') ?? undefined)).toEqual(categories);
    }
  });
});
