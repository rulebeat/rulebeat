/**
 * A saved view open on /scans is the first layer, and the address holds only the differences from it
 * (ADR 0013). `savedViewAddress(saved)` is the one reader and writer of those differences. Any is the
 * empty value; status, sort, gsort and the window have none and are written in full when they differ.
 */
import { describe, expect, it } from 'vitest';
import {
  emptyView, savedViewAddress, viewFromSearchParams, viewToSearchParams, type View,
} from '@/lib/finding-view';

const viewOf = (query: string): View => viewFromSearchParams(new URLSearchParams(query));
const pairs = (params: URLSearchParams) => [...params].map(([k, v]) => `${k}=${v}`);

const SAVED = viewOf(
  'category=security&severity=critical%2Chigh&subscription=sub-a%2Csub-b&status=all&window=30&q=vm'
  + '&cols=zone%2Csku&sort=rule%3Adesc&group=category&gsort=count%3Adesc&f=kind%3Dadvisory&rf=zone%3Da%7Cb',
);

describe('writing the differences from the saved view', () => {
  it('writes nothing for a view that is the saved view', () => {
    expect(pairs(savedViewAddress(SAVED).write(SAVED))).toEqual([]);
  });

  it('keeps the params the page owns first and writes the page as navigation', () => {
    const params = savedViewAddress(SAVED).write({ ...SAVED, page: 3 }, { tab: 'results', view: 'v1' });
    expect(pairs(params)).toEqual(['tab=results', 'view=v1', 'page=3']);
  });

  it('writes only the dimension that changed, and leaves the saved ones to be inherited', () => {
    const current = { ...SAVED, filters: SAVED.filters.map(f => (f.field === 'severity' ? { ...f, values: ['low'] } : f)) };
    expect(pairs(savedViewAddress(SAVED).write(current))).toEqual(['severity=low']);
  });

  it('compares a value list as a set', () => {
    const current = { ...SAVED, filters: SAVED.filters.map(f => (f.field === 'subscription' ? { ...f, values: ['sub-b', 'sub-a'] } : f)) };
    expect(pairs(savedViewAddress(SAVED).write(current))).toEqual([]);
  });

  it('writes Any as the empty value for a list, a generic field, the search, the columns and the grouping', () => {
    const current: View = {
      ...SAVED,
      filters: SAVED.filters.filter(f => !['severity', 'kind'].includes(f.field) && f.field !== 'row.zone'),
      search: '', columns: [], groupBy: [],
    };
    expect(pairs(savedViewAddress(SAVED).write(current))).toEqual(['severity=', 'f=kind=', 'q=', 'cols=', 'group=', 'rf=zone']);
  });

  it('writes a returned-column filter with no values as rf=<path> and blank rows as rf=<path>=', () => {
    const noFilter = { ...SAVED, filters: SAVED.filters.filter(f => f.field !== 'row.zone') };
    expect(pairs(savedViewAddress(SAVED).write(noFilter))).toEqual(['rf=zone']);
    const blank = { ...SAVED, filters: SAVED.filters.map(f => (f.field === 'row.zone' ? { ...f, values: [''] } : f)) };
    expect(pairs(savedViewAddress(SAVED).write(blank))).toEqual(['rf=zone=']);
  });

  it('writes status, sort, gsort and the window in full when they differ, defaults included', () => {
    const current: View = {
      ...SAVED,
      filters: SAVED.filters.filter(f => f.field !== 'status'),
      window: { mode: 'relative', days: 7 }, sort: null, groupSort: { by: 'value', dir: 'asc' },
    };
    expect(pairs(savedViewAddress(SAVED).write(current))).toEqual(['status=open', 'window=7', 'sort=severity:asc', 'gsort=value:asc']);
  });

  it('writes a custom window as from and to together', () => {
    const current: View = { ...SAVED, window: { mode: 'custom', from: '2026-01-01', to: '2026-01-31' } };
    expect(pairs(savedViewAddress(SAVED).write(current))).toEqual(['from=2026-01-01', 'to=2026-01-31']);
  });

  it('reads a null sort as the default, so a saved default is not a difference', () => {
    const saved = emptyView();
    expect(pairs(savedViewAddress(saved).write({ ...saved, sort: { field: 'severity', dir: 'asc' } }))).toEqual([]);
  });
});

describe('reading the differences', () => {
  const read = (query: string) => savedViewAddress(SAVED).read(new URLSearchParams(query));

  it('inherits everything an address does not name', () => {
    expect(read('tab=results&view=v1')).toEqual(SAVED);
  });

  it('replaces only the dimensions the address names', () => {
    const view = read('severity=low');
    expect(view.filters.find(f => f.field === 'severity')?.values).toEqual(['low']);
    expect(view.filters.find(f => f.field === 'subscription')?.values).toEqual(['sub-a', 'sub-b']);
  });

  it('reads the empty value as Any, for a list, a generic field, the search, the columns and the grouping', () => {
    const view = read('severity=&f=kind%3D&q=&cols=&group=');
    expect(view.filters.map(f => f.field)).toEqual(['category', 'status', 'subscription', 'row.zone']);
    expect(view.search).toBe('');
    expect(view.columns).toEqual([]);
    expect(view.groupBy).toEqual([]);
  });

  it('reads rf=<path> with no = as Any and rf=<path>= as blank rows', () => {
    expect(read('rf=zone').filters.some(f => f.field === 'row.zone')).toBe(false);
    expect(read('rf=zone%3D').filters.find(f => f.field === 'row.zone')?.values).toEqual(['']);
  });

  it('keys a returned-column filter by its path and leaves the others alone', () => {
    const saved = viewOf('rf=zone%3Da&rf=sku%3Db');
    const view = savedViewAddress(saved).read(new URLSearchParams('rf=zone%3Dc'));
    expect(view.filters.map(f => [f.field, f.values])).toEqual([['row.zone', ['c']], ['row.sku', ['b']]]);
  });

  it('counts a param of only malformed or unknown values as missing, never as Any', () => {
    const view = read('severity=bogus&status=sideways&window=-4&sort=nonsense&gsort=x%3Ay&group=nope&cols=%2C%2C');
    expect(view).toEqual(SAVED);
  });

  it('reads status, sort, gsort and the window as written', () => {
    const view = read('status=open&window=7&sort=severity%3Aasc&gsort=value%3Aasc');
    expect(view.filters.some(f => f.field === 'status')).toBe(false);
    expect(view.window).toEqual({ mode: 'relative', days: 7 });
    expect(view.sort).toBeNull();
    expect(view.groupSort).toEqual({ by: 'value', dir: 'asc' });
  });

  it('reads the page, which is navigation and never part of the saved view', () => {
    expect(read('page=4').page).toBe(4);
  });

  it('reads an old full copy of the saved view as the saved view', () => {
    expect(read(viewToSearchParams(SAVED).toString())).toEqual(SAVED);
  });

  it('never widens: a full copy that lacks a dimension the view now saves inherits it', () => {
    const view = savedViewAddress(SAVED).read(new URLSearchParams('severity=low&status=all'));
    expect(view.filters.find(f => f.field === 'subscription')?.values).toEqual(['sub-a', 'sub-b']);
  });
});

describe('writing and reading back', () => {
  const CHANGED: Record<string, View> = {
    'a narrower list': viewOf('category=security&severity=low&subscription=sub-a%2Csub-b&status=all&window=30&q=vm&cols=zone%2Csku&sort=rule%3Adesc&group=category&gsort=count%3Adesc&f=kind%3Dadvisory&rf=zone%3Da%7Cb'),
    'everything Any': { ...emptyView() },
    'a custom window and a page': { ...SAVED, window: { mode: 'custom', from: '2026-01-01', to: '2026-01-31' }, page: 5 },
    'new filters': { ...SAVED, filters: [...SAVED.filters, { field: 'location', values: ['westeurope'] }, { field: 'row.sku', values: ['x', ''] }] },
    'a value with an equals sign, bar and comma': { ...SAVED, filters: [...SAVED.filters, { field: 'row.a=b', values: ['x=1', 'y|z', 'c,d'] }] },
    'another search and grouping': { ...SAVED, search: 'a&b, c', groupBy: ['location', 'row.zone'], columns: ['sku'] },
  };

  it.each(Object.entries(CHANGED))('reads %s back as the same view', (_name, current) => {
    const address = savedViewAddress(SAVED);
    const written = address.write(current);
    const back = address.read(written);
    const byField = (v: View) => [...v.filters].sort((a, b) => a.field.localeCompare(b.field));
    expect({ ...back, filters: byField(back) }).toEqual({ ...current, filters: byField(current) });
  });
});
