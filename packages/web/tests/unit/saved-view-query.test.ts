import { describe, expect, it } from 'vitest';
import {
  OPEN_VIEW_PARAM, isSavedViewTab, normalizeViewQuery, savedViewHref,
} from '@/lib/saved-view-query';
import { emptyView, viewFromSearchParams, viewToSearchParams } from '@/lib/finding-view';

describe('normalizeViewQuery', () => {
  it('keeps a query the View writes unchanged', () => {
    const view = { ...emptyView(), search: 'storage', columns: ['properties.sku'], page: 3 };
    const query = viewToSearchParams(view).toString();
    expect(normalizeViewQuery(query)).toBe(query);
  });

  it('drops params the View does not know, including the page-owned ones', () => {
    expect(normalizeViewQuery('tab=results&view=abc&severity=critical&junk=1')).toBe('severity=critical');
  });

  it('drops defaults, so a default View is an empty query', () => {
    expect(normalizeViewQuery('status=open&window=7')).toBe('');
  });

  it('is idempotent, and the result reads back as the same View', () => {
    const once = normalizeViewQuery('f=resourceType%3Dmicrosoft.sql%2Fservers&rf=a.b%3Dx%7Cy&sort=severity%3Adesc');
    expect(normalizeViewQuery(once)).toBe(once);
    expect(viewToSearchParams(viewFromSearchParams(new URLSearchParams(once))).toString()).toBe(once);
  });
});

describe('saved view helpers', () => {
  it('knows the three tabs a view can open on', () => {
    expect(isSavedViewTab('results')).toBe(true);
    expect(isSavedViewTab('advisories')).toBe(true);
    expect(isSavedViewTab('activity')).toBe(true);
    expect(isSavedViewTab('runs')).toBe(false);
  });
});

describe('savedViewHref', () => {
  const view = { id: 'v1', tab: 'advisories' as const, query: 'severity=critical&q=a%26b' };

  it('puts the tab and the view id first, then the saved query', () => {
    expect(savedViewHref(view)).toBe('/scans?tab=advisories&view=v1&severity=critical&q=a%26b');
  });

  it('reads back as the saved View, ignoring the tab and view params', () => {
    const href = savedViewHref(view);
    const params = new URLSearchParams(href.split('?')[1]);
    expect(params.get(OPEN_VIEW_PARAM)).toBe('v1');
    expect(viewToSearchParams(viewFromSearchParams(params)).toString()).toBe(view.query);
  });

  it('keeps a repeated param repeated', () => {
    const href = savedViewHref({ ...view, query: 'x=1&x=2' });
    expect(new URLSearchParams(href.split('?')[1]).getAll('x')).toEqual(['1', '2']);
  });

  it('is just the tab and id for an empty query', () => {
    expect(savedViewHref({ ...view, query: '' })).toBe('/scans?tab=advisories&view=v1');
  });
});
