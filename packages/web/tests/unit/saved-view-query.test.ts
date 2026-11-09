import { describe, expect, it } from 'vitest';
import {
  OPEN_VIEW_PARAM, isSavedViewTab, normalizeViewQuery, savedViewHref,
} from '@/lib/saved-view-query';
import { emptyView, viewFromSearchParams, viewToSearchParams } from '@/lib/finding-view';

describe('normalizeViewQuery', () => {
  it('keeps a query the View writes unchanged', () => {
    const view = { ...emptyView(), search: 'storage', columns: ['properties.sku'] };
    const query = viewToSearchParams(view).toString();
    expect(normalizeViewQuery(query)).toBe(query);
  });

  it('drops params the View does not know, including the page-owned ones', () => {
    expect(normalizeViewQuery('tab=results&view=abc&severity=critical&junk=1')).toBe('severity=critical');
  });

  it('drops the page, which is where the viewer is and never part of a saved view', () => {
    expect(normalizeViewQuery('severity=critical&page=3')).toBe('severity=critical');
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

  it('writes only the tab and the view id: the view\'s query is read from the view, not copied', () => {
    expect(savedViewHref(view)).toBe('/scans?tab=advisories&view=v1');
  });

  it('opens the same address whatever the view holds', () => {
    const emptied = { ...view, query: '' };
    expect(savedViewHref(emptied)).toBe(savedViewHref(view));
  });

  it('names the view in the param the explorer reads', () => {
    expect(new URLSearchParams(savedViewHref(view).split('?')[1]).get(OPEN_VIEW_PARAM)).toBe('v1');
  });
});
