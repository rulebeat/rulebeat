/**
 * ADR 0008: the address of a compare. `?compare=<idA>..<idB>` keeps the meaning it always had, so a link
 * made before the compare moved to the server opens the same one; the side and the page are written by one
 * function and read by another, so the server page and the screen never disagree; and no parameter of the
 * compare is one the findings explorer or the snapshot on the same page reads.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { emptyView, viewFromSearchParams, viewToSearchParams, type View } from '@/lib/finding-view';
import { SNAPSHOT_PARAMS, emptySnapshotQuery, snapshotQueryFromParams, snapshotQueryToParams } from '@/lib/snapshot-query';
import {
  COMPARE_PARAMS, emptyCompareQuery, compareQueryFromParams, compareQueryToParams, parseCompareIds, type CompareQuery,
} from '@/lib/compare-query';
import { compareAddress } from '@/lib/compare-screen';

const BASE = new URLSearchParams('tab=history&compare=run-1..run-2');
const query = (over: Partial<CompareQuery> = {}): CompareQuery => ({ ...emptyCompareQuery(), ...over });

describe('an existing ?compare= link', () => {
  it('asks for the Added side, first page, as it always did', () => {
    expect(compareQueryFromParams(new URLSearchParams('tab=history&compare=run-1..run-2'))).toEqual(emptyCompareQuery());
    expect(emptyCompareQuery()).toEqual({ side: 'added', page: 1 });
  });

  it('is left exactly as it was when the compare has nothing to add', () => {
    expect(compareQueryToParams(emptyCompareQuery(), BASE).toString()).toBe(BASE.toString());
    expect(compareAddress(['run-1', 'run-2'], emptyCompareQuery(), new URLSearchParams('tab=history')))
      .toBe('tab=history&compare=run-1..run-2');
  });

  it('names its two scans the way it always did, in either order', () => {
    expect(parseCompareIds('run-1..run-2')).toEqual(['run-1', 'run-2']);
    expect(parseCompareIds('run-2..run-1')).toEqual(['run-2', 'run-1']);
  });

  it.each([undefined, null, '', 'run-1', 'run-1..', '..run-2', 'a..b..c'])('does not name two scans in %j', value => {
    expect(parseCompareIds(value)).toBeNull();
  });

  it('keeps the page\'s own parameters, first and untouched, when the compare writes its own', () => {
    const written = compareQueryToParams(query({ side: 'fixed', page: 2 }), BASE).toString();
    expect(written.startsWith(`${BASE.toString()}&`)).toBe(true);
    const params = new URLSearchParams(written);
    expect([params.get('tab'), params.get('compare')]).toEqual(['history', 'run-1..run-2']);
  });
});

describe('what the screen writes and the server page reads', () => {
  const QUERIES: CompareQuery[] = [
    query(),
    query({ side: 'fixed' }),
    query({ side: 'persisted' }),
    query({ page: 7 }),
    query({ side: 'fixed', page: 3 }),
  ];

  it.each(QUERIES.map(q => [JSON.stringify(q), q] as const))('give the same query back through the address: %s', (_name, q) => {
    const written = compareQueryToParams(q, BASE);
    // The page reads a record of strings; the browser reads URLSearchParams. Both agree.
    const asRecord: Record<string, string> = {};
    for (const key of new Set(written.keys())) asRecord[key] = written.get(key)!;
    expect(compareQueryFromParams(asRecord)).toEqual(q);
    expect(compareQueryFromParams(new URLSearchParams(written.toString()))).toEqual(q);
  });

  it('leaves the defaults out of the address', () => {
    expect(compareQueryToParams(query({ side: 'added', page: 1 }), BASE).toString()).toBe(BASE.toString());
    expect(compareQueryToParams(query({ side: 'fixed' }), BASE).has(COMPARE_PARAMS.page)).toBe(false);
    expect(compareQueryToParams(query({ page: 2 }), BASE).has(COMPARE_PARAMS.side)).toBe(false);
  });

  it('writes again over its own parameters instead of adding to them', () => {
    const once = compareQueryToParams(query({ side: 'fixed', page: 2 }), BASE);
    const again = compareQueryToParams(query({ side: 'persisted' }), once);
    expect(again.getAll(COMPARE_PARAMS.side)).toEqual(['persisted']);
    expect(again.has(COMPARE_PARAMS.page)).toBe(false);
    const back = compareQueryToParams(emptyCompareQuery(), again);
    expect(back.toString()).toBe(BASE.toString());
  });

  it('ignores a malformed address rather than refusing it', () => {
    expect(compareQueryFromParams(new URLSearchParams('compareSide=bogus&comparePage=-4'))).toEqual(emptyCompareQuery());
    expect(compareQueryFromParams(new URLSearchParams('compareSide=fixed&comparePage=abc'))).toEqual(query({ side: 'fixed' }));
    expect(compareQueryFromParams(new URLSearchParams('comparePage=9999999999')).page).toBe(1);
    expect(compareQueryFromParams(new URLSearchParams('comparePage=2.5')).page).toBe(1);
  });

  it('is written onto the page\'s other parameters by compareAddress', () => {
    const written = new URLSearchParams(compareAddress(['run-1', 'run-2'], query({ side: 'persisted', page: 4 }), new URLSearchParams('tab=history&snapPage=2')));
    expect(Object.fromEntries(written)).toEqual({ tab: 'history', snapPage: '2', compare: 'run-1..run-2', compareSide: 'persisted', comparePage: '4' });
  });
});

describe('the compare, the snapshot and the explorer on one page', () => {
  const explorerView: View = {
    ...emptyView(),
    filters: [{ field: 'severity', values: ['low'] }, { field: 'rule', values: ['explorer-rule'] }],
    search: 'explorer text',
    page: 5,
  };
  const explorerNames = new Set(viewToSearchParams({
    ...explorerView,
    filters: [...explorerView.filters, { field: 'status', values: ['all'] }, { field: 'category', values: ['c'] }, { field: 'tags', values: ['t'] }],
    columns: ['a'], sort: { field: 'severity', dir: 'desc' }, groupBy: ['rule'], window: { mode: 'relative', days: 30 },
  }, { view: 'saved-1' }).keys());

  it('share no parameter name', () => {
    for (const name of Object.values(COMPARE_PARAMS)) expect(explorerNames.has(name)).toBe(false);
    const snapshotNames = new Set<string>(Object.values(SNAPSHOT_PARAMS));
    for (const name of Object.values(COMPARE_PARAMS)) expect(snapshotNames.has(name)).toBe(false);
  });

  it('are not read as each other\'s', () => {
    const compare = compareQueryToParams(query({ side: 'fixed', page: 3 }), BASE);
    expect(viewFromSearchParams(compare)).toEqual(emptyView());
    expect(snapshotQueryFromParams(compare)).toEqual(emptySnapshotQuery());
    const withExplorer = viewToSearchParams(explorerView, compare);
    expect(compareQueryFromParams(withExplorer)).toEqual(query({ side: 'fixed', page: 3 }));
    const withSnapshot = snapshotQueryToParams({ ...emptySnapshotQuery(), severity: ['high'], page: 2 }, compare);
    expect(compareQueryFromParams(withSnapshot)).toEqual(query({ side: 'fixed', page: 3 }));
    expect(compareQueryFromParams(viewToSearchParams(explorerView, BASE))).toEqual(emptyCompareQuery());
  });
});

describe('the server page', () => {
  const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', '(app)', 'scans', 'page.tsx'), 'utf8');

  it('reads the compare\'s ids and query with the one reader, and no longer loads the two scans', () => {
    expect(page).toContain('compareQueryFromParams(params)');
    expect(page).toContain('parseCompareIds(');
    expect(page).not.toMatch(/getScanById/);
  });
});
