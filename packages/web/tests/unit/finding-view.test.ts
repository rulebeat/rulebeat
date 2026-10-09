/**
 * The view engine (ADR 0006), driven through its public functions only: findings with rows and a
 * View go in, the page to show comes out. Covers built-in filters, returned-column filters that
 * keep only matching rows, column cells, URL detection, sort with empties last, paging, a view that
 * names a column no finding has, and the URL round trip.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GENERIC_FIELDS, applyView, classifyValue, clearFilter, columnCell, emptyView, fieldOptions, filterFindings, findingSubject, rowFieldOptions, rowLeafPaths,
  toggleFilterValue, viewFromSearchParams, viewToSearchParams,
  type View, type ViewFinding, type ViewFilter,
} from '@/lib/finding-view';

type F = ViewFinding & { fingerprint: string };

function f(id: string, overrides: Partial<F> = {}): F {
  return {
    fingerprint: id, category: 'reliability', severity: 'medium', status: 'active', ruleId: 'rule-a',
    subscriptionId: 'sub-1', resourceGroup: 'rg-1', location: 'westeurope',
    resourceType: 'microsoft.compute/virtualmachines', resourceName: id, resourceId: `/subscriptions/sub-1/${id}`,
    title: 'title', firstSeenAt: '2026-09-01T00:00:00.000Z', lastSeenAt: '2026-10-07T00:00:00.000Z',
    policyName: 'Rule A', ruleTags: [], rows: [],
    ...overrides,
  };
}

function view(overrides: Partial<View> = {}): View {
  return { ...emptyView(), ...overrides };
}

const ids = (findings: { fingerprint: string }[]) => findings.map(x => x.fingerprint);
const shown = (findings: F[], v: View) => ids(applyView(findings, v).matched.map(m => m.finding));

describe('built-in filters', () => {
  const vm1 = f('vm1', { severity: 'critical', kind: 'advisory', category: 'reliability', ruleId: 'rule-a', ruleTags: ['retirement'] });
  const vm2 = f('vm2', { severity: 'low', category: 'security', ruleId: 'rule-b', policyName: 'Rule B', subscriptionId: 'sub-2', resourceGroup: 'rg-2', location: 'northeurope', resourceType: 'microsoft.storage/storageaccounts' });
  const vm3 = f('vm3', { severity: 'high', firstSeenAt: '2026-10-06T00:00:00.000Z', lastSeenAt: '2026-10-06T10:00:00.000Z' });
  const all = [vm1, vm2, vm3];
  const by = (filters: ViewFilter[]) => shown(all, view({ filters, sort: { field: 'resourceName', dir: 'asc' } }));

  it('filters on each built-in field', () => {
    expect(by([{ field: 'rule', values: ['rule-b'] }])).toEqual(['vm2']);
    expect(by([{ field: 'kind', values: ['advisory'] }])).toEqual(['vm1']);
    expect(by([{ field: 'kind', values: ['state'] }])).toEqual(['vm2', 'vm3']);
    expect(by([{ field: 'category', values: ['security'] }])).toEqual(['vm2']);
    expect(by([{ field: 'severity', values: ['critical', 'high'] }])).toEqual(['vm1', 'vm3']);
    expect(by([{ field: 'subscription', values: ['sub-2'] }])).toEqual(['vm2']);
    expect(by([{ field: 'resourceGroup', values: ['rg-2'] }])).toEqual(['vm2']);
    expect(by([{ field: 'location', values: ['northeurope'] }])).toEqual(['vm2']);
    expect(by([{ field: 'resourceType', values: ['microsoft.storage/storageaccounts'] }])).toEqual(['vm2']);
    expect(by([{ field: 'resourceName', values: ['vm3'] }])).toEqual(['vm3']);
    expect(by([{ field: 'tags', values: ['retirement'] }])).toEqual(['vm1']);
    expect(by([{ field: 'firstSeen', values: ['2026-10-06'] }])).toEqual(['vm3']);
    expect(by([{ field: 'lastSeen', values: ['2026-10-06'] }])).toEqual(['vm3']);
  });

  it('combines filters on different fields with AND', () => {
    expect(by([{ field: 'severity', values: ['critical', 'high'] }, { field: 'category', values: ['reliability'] }])).toEqual(['vm1', 'vm3']);
    expect(by([{ field: 'severity', values: ['critical'] }, { field: 'category', values: ['security'] }])).toEqual([]);
  });

  it('leaves out the fields named in except, so a dropdown counts from every other filter', () => {
    const filters: ViewFilter[] = [{ field: 'severity', values: ['critical'] }, { field: 'subscription', values: ['sub-2'] }];
    expect(ids(filterFindings(all, view({ filters }), {}, { except: new Set(['subscription']) }))).toEqual(['vm1']);
    expect(ids(filterFindings(all, view({ filters }), {}, { except: new Set(['subscription', 'severity']) }))).toEqual(['vm1', 'vm2', 'vm3']);
  });

  it('drops a closed finding by default and keeps New and Fixed bounded by the window', () => {
    const fixedRecent = f('fixed-recent', { status: 'fixed', resolvedAt: '2026-10-05T00:00:00.000Z' });
    const fixedOld = f('fixed-old', { status: 'fixed', resolvedAt: '2026-08-01T00:00:00.000Z' });
    const range = { from: '2026-10-01', to: '2026-10-07' };
    const pool = [...all, fixedRecent, fixedOld];
    const status = (value: string) => ids(filterFindings(pool, view({ filters: [{ field: 'status', values: [value] }] }), { range }));
    expect(ids(filterFindings(pool, view(), { range }))).toEqual(['vm1', 'vm2', 'vm3']);
    expect(status('new')).toEqual(['vm3']);
    expect(status('fixed')).toEqual(['fixed-recent']);
    expect(status('all')).toEqual(['vm1', 'vm2', 'vm3', 'fixed-recent']);
  });

  it('hides suppressed findings unless asked to show them', () => {
    const ctx = { suppressedFingerprints: new Set(['vm2']) };
    expect(ids(filterFindings(all, view(), ctx))).toEqual(['vm1', 'vm3']);
    expect(ids(filterFindings(all, view(), { ...ctx, showSuppressed: true }))).toEqual(['vm1', 'vm2', 'vm3']);
  });

  it('searches resource, rule, type and resource id', () => {
    expect(shown(all, view({ search: 'storageaccounts' }))).toEqual(['vm2']);
    expect(shown(all, view({ search: 'RULE A' }))).toEqual(['vm1', 'vm3']);
  });
});

describe('header funnels are ordinary view filters', () => {
  const vm1 = f('vm1', { severity: 'critical', ruleId: 'rule-a', policyName: 'Rule A', category: 'reliability', firstSeenAt: '2026-10-06T08:00:00.000Z' });
  const vm2 = f('vm2', { severity: 'low', ruleId: 'rule-b', policyName: 'Rule B', category: 'security', firstSeenAt: '2026-10-01T08:00:00.000Z' });
  const activity = f('act', {
    kind: 'activity', resourceName: undefined, resourceId: undefined, dimensionKey: 'pattern-7',
    ruleId: 'rule-b', policyName: 'Rule B', category: 'security', firstSeenAt: '2026-10-01T09:00:00.000Z',
  });
  const unnamed = f('unnamed', { resourceName: '', resourceId: '/subscriptions/s/resourceGroups/g/providers/p/disks/disk-9' });
  const all = [vm1, vm2, activity, unnamed];
  const by = (filters: ViewFilter[]) => shown(all, view({ filters, sort: { field: 'resourceName', dir: 'asc' } }));

  it('names a finding by what the Resource column shows: name, then activity pattern, then the id tail', () => {
    expect(findingSubject(vm1)).toBe('vm1');
    expect(findingSubject(activity)).toBe('pattern-7');
    expect(findingSubject(unnamed)).toBe('disk-9');
    expect(findingSubject({})).toBe('');
  });

  it('filters the Resource, Rule, Category, Severity and First seen funnels through filterFindings', () => {
    expect(by([{ field: 'resourceName', values: ['pattern-7', 'disk-9'] }])).toEqual(['unnamed', 'act']);
    expect(by([{ field: 'rule', values: ['rule-b'] }])).toEqual(['act', 'vm2']);
    expect(by([{ field: 'category', values: ['security'] }])).toEqual(['act', 'vm2']);
    expect(by([{ field: 'severity', values: ['critical'] }])).toEqual(['vm1']);
    expect(by([{ field: 'firstSeen', values: ['2026-10-01'] }])).toEqual(['act', 'vm2']);
  });

  it('counts a funnel from every other filter, leaving its own out', () => {
    const filters: ViewFilter[] = [{ field: 'category', values: ['security'] }, { field: 'firstSeen', values: ['2026-10-06'] }];
    const pool = filterFindings(all, view({ filters }), {}, { except: new Set(['firstSeen']) });
    expect(ids(pool)).toEqual(['vm2', 'act']);
  });

  it('sorts by the label the Resource column shows', () => {
    const order = shown(all, view({ sort: { field: 'resourceName', dir: 'asc' } }));
    expect(order).toEqual(['unnamed', 'act', 'vm1', 'vm2']);
  });

  it('lists the values present on a built-in field, with counts, for the Add filter control', () => {
    expect(fieldOptions(all, 'category')).toEqual([{ value: 'reliability', count: 2 }, { value: 'security', count: 2 }]);
    expect(fieldOptions(all, 'resourceName')).toEqual([
      { value: 'disk-9', count: 1 }, { value: 'pattern-7', count: 1 }, { value: 'vm1', count: 1 }, { value: 'vm2', count: 1 },
    ]);
    expect(fieldOptions(all, 'firstSeen')).toEqual([
      { value: '2026-09-01', count: 1 }, { value: '2026-10-01', count: 2 }, { value: '2026-10-06', count: 1 },
    ]);
    expect(fieldOptions([f('t', { ruleTags: ['a', 'b'] }), f('u', { ruleTags: ['b'] })], 'tags')).toEqual([
      { value: 'a', count: 1 }, { value: 'b', count: 2 },
    ]);
    expect(fieldOptions([f('x', { location: undefined })], 'location')).toEqual([]);
  });
});

describe('returned-column filters', () => {
  const twoRetirements = f('vm-two', {
    rows: [{ feature: 'Basic IP', retirementDate: '2026-09-30', properties: { sku: 'basic' } },
           { feature: 'Old API', retirementDate: '2027-03-31', properties: { sku: 'std' } }],
  });
  const oneRetirement = f('vm-one', { rows: [{ feature: 'Old API', retirementDate: '2027-03-31', properties: { sku: 'std' } }] });
  const noRows = f('vm-none', { rows: [] });
  const all = [twoRetirements, oneRetirement, noRows];

  it('keeps only the matching rows of a finding', () => {
    const page = applyView(all, view({ filters: [{ field: 'row.feature', values: ['Basic IP'] }] }));
    expect(page.items.map(i => i.finding.fingerprint)).toEqual(['vm-two']);
    expect(page.items[0].rows).toEqual([twoRetirements.rows![0]]);
  });

  it('drops a finding with no matching row, and one with no rows at all', () => {
    expect(shown(all, view({ filters: [{ field: 'row.feature', values: ['Old API'] }] }))).toEqual(['vm-two', 'vm-one']);
    expect(shown(all, view({ filters: [{ field: 'row.feature', values: ['Nothing'] }] }))).toEqual([]);
  });

  it('shows every row of a finding when no row filter is set', () => {
    const page = applyView(all, view());
    expect(page.items.find(i => i.finding.fingerprint === 'vm-two')!.rows).toHaveLength(2);
  });

  it('combines row filters on the same row, so two columns must both match one row', () => {
    const both = shown(all, view({ filters: [{ field: 'row.feature', values: ['Basic IP'] }, { field: 'row.retirementDate', values: ['2027-03-31'] }] }));
    expect(both).toEqual([]);
    const same = shown(all, view({ filters: [{ field: 'row.feature', values: ['Old API'] }, { field: 'row.retirementDate', values: ['2027-03-31'] }] }));
    expect(same).toEqual(['vm-two', 'vm-one']);
  });

  it('reads a nested value by dot path and compares it as text', () => {
    const page = applyView(all, view({ filters: [{ field: 'row.properties.sku', values: ['basic'] }] }));
    expect(page.items.map(i => i.finding.fingerprint)).toEqual(['vm-two']);
    const numeric = f('n', { rows: [{ count: 3 }, { count: 4 }] });
    expect(applyView([numeric], view({ filters: [{ field: 'row.count', values: ['3'] }] })).items[0].rows).toEqual([{ count: 3 }]);
  });

  it('applies alongside built-in filters', () => {
    const other = f('vm-other', { severity: 'critical', rows: [{ feature: 'Old API' }] });
    const filters: ViewFilter[] = [{ field: 'row.feature', values: ['Old API'] }, { field: 'severity', values: ['critical'] }];
    expect(shown([...all, other], view({ filters }))).toEqual(['vm-other']);
  });

  it('reads a finding stored before rows existed as one row made from its evidence', () => {
    const legacy = f('legacy', { rows: undefined, evidence: { feature: 'Old API' } });
    expect(shown([legacy], view({ filters: [{ field: 'row.feature', values: ['Old API'] }] }))).toEqual(['legacy']);
  });

  it('counts the values a column holds for a header filter, leaving its own filter out', () => {
    const filters: ViewFilter[] = [{ field: 'row.feature', values: ['Basic IP'] }, { field: 'row.retirementDate', values: ['2027-03-31'] }];
    expect(rowFieldOptions(all, filters, 'feature')).toEqual([{ value: 'Old API', count: 2 }]);
    expect(rowFieldOptions(all, [], 'feature')).toEqual([{ value: 'Basic IP', count: 1 }, { value: 'Old API', count: 2 }]);
  });

  it('toggles a value on a column filter and removes the filter when none is left', () => {
    const once = toggleFilterValue([], 'row.feature', 'Old API');
    expect(once).toEqual([{ field: 'row.feature', values: ['Old API'] }]);
    const twice = toggleFilterValue(once, 'row.feature', 'Basic IP');
    expect(twice).toEqual([{ field: 'row.feature', values: ['Old API', 'Basic IP'] }]);
    expect(toggleFilterValue(toggleFilterValue(twice, 'row.feature', 'Old API'), 'row.feature', 'Basic IP')).toEqual([]);
    expect(clearFilter(twice, 'row.feature')).toEqual([]);
  });

  it('toggles a built-in field the same way, leaving the other filters alone', () => {
    const base: ViewFilter[] = [{ field: 'severity', values: ['high'] }];
    const added = toggleFilterValue(base, 'location', 'westeurope');
    expect(added).toEqual([{ field: 'severity', values: ['high'] }, { field: 'location', values: ['westeurope'] }]);
    expect(toggleFilterValue(added, 'location', 'westeurope')).toEqual(base);
    expect(clearFilter(added, 'severity')).toEqual([{ field: 'location', values: ['westeurope'] }]);
  });
});

describe('a column no finding has', () => {
  const a = f('a', { rows: [{ feature: 'x' }] });
  const b = f('b', { rows: [{ feature: 'y' }] });

  it('is empty for every finding, with no error', () => {
    expect(columnCell(a.rows!, 'nope')).toEqual({ value: { kind: 'empty' }, more: 0 });
    const page = applyView([a, b], view({ columns: ['nope'] }));
    expect(page.total).toBe(2);
  });

  it('as a filter keeps nothing', () => {
    expect(shown([a, b], view({ filters: [{ field: 'row.nope', values: ['x'] }] }))).toEqual([]);
  });

  it('as a sort leaves the findings in their order', () => {
    expect(shown([b, a], view({ sort: { field: 'row.nope', dir: 'desc' } }))).toEqual(['b', 'a']);
  });
});

describe('columns', () => {
  it('lists every leaf path the rows hold, walking nested objects three levels and leaving arrays whole', () => {
    const rows = [
      { name: 'x', properties: { sku: 'basic', deep: { a: { b: 1 } } }, tags: ['t1'], _rule: { field: 'f' } },
      { name: 'y', extra: null },
    ];
    expect(rowLeafPaths([f('a', { rows })])).toEqual(['extra', 'name', 'properties.deep.a', 'properties.sku', 'tags']);
  });

  it('shows one distinct value as it is, and several as the first plus how many more', () => {
    const rows = [{ d: '2026-09-30' }, { d: '2026-09-30' }, { d: '2027-03-31' }, { d: '' }, { d: '2028-01-01' }];
    expect(columnCell(rows.slice(0, 2), 'd')).toEqual({ value: { kind: 'text', text: '2026-09-30' }, more: 0 });
    expect(columnCell(rows, 'd')).toEqual({ value: { kind: 'text', text: '2026-09-30' }, more: 2 });
  });

  it('the rows a row filter kept are the rows a cell reads', () => {
    const finding = f('a', { rows: [{ d: '1' }, { d: '2' }] });
    const [item] = applyView([finding], view({ filters: [{ field: 'row.d', values: ['2'] }] })).items;
    expect(columnCell(item.rows, 'd').value).toEqual({ kind: 'text', text: '2' });
  });
});

describe('classifying a returned value', () => {
  it('reads an http or https URL as a link', () => {
    expect(classifyValue('https://learn.microsoft.com/azure')).toEqual({ kind: 'url', text: 'https://learn.microsoft.com/azure', href: 'https://learn.microsoft.com/azure' });
    expect(classifyValue('http://example.com')).toMatchObject({ kind: 'url' });
  });

  it('does not read other schemes, or text that merely mentions a URL, as a link', () => {
    expect(classifyValue('javascript:alert(1)')).toEqual({ kind: 'text', text: 'javascript:alert(1)' });
    expect(classifyValue('ftp://example.com')).toMatchObject({ kind: 'text' });
    expect(classifyValue('see https://example.com now')).toMatchObject({ kind: 'text' });
  });

  it('shows objects and arrays as compact JSON', () => {
    expect(classifyValue({ a: 1, b: [2] })).toEqual({ kind: 'json', text: '{"a":1,"b":[2]}' });
    expect(classifyValue(['x', 'y'])).toEqual({ kind: 'json', text: '["x","y"]' });
  });

  it('shows null, undefined and an empty string as empty, and keeps 0 and false', () => {
    expect(classifyValue(null).kind).toBe('empty');
    expect(classifyValue(undefined).kind).toBe('empty');
    expect(classifyValue('').kind).toBe('empty');
    expect(classifyValue(0)).toEqual({ kind: 'text', text: '0' });
    expect(classifyValue(false)).toEqual({ kind: 'text', text: 'false' });
  });
});

describe('sort', () => {
  const a = f('a', { severity: 'low', resourceName: 'alpha', rows: [{ n: 10, d: 'b' }] });
  const b = f('b', { severity: 'critical', resourceName: undefined, resourceId: undefined, rows: [{ n: 9, d: '' }] });
  const c = f('c', { severity: 'high', resourceName: 'charlie', rows: [{ n: 100 }] });
  const d = f('d', { severity: 'high', resourceName: 'bravo', rows: [] });
  const all = [a, b, c, d];

  it('defaults to severity, most severe first, keeping the input order within a severity', () => {
    expect(shown(all, view())).toEqual(['b', 'c', 'd', 'a']);
  });

  it('sorts a built-in field both ways with empty values last either way', () => {
    expect(shown(all, view({ sort: { field: 'resourceName', dir: 'asc' } }))).toEqual(['a', 'd', 'c', 'b']);
    expect(shown(all, view({ sort: { field: 'resourceName', dir: 'desc' } }))).toEqual(['c', 'd', 'a', 'b']);
  });

  it('sorts a returned column by the first shown row, numbers numerically, empties last either way', () => {
    expect(shown(all, view({ sort: { field: 'row.n', dir: 'asc' } }))).toEqual(['b', 'a', 'c', 'd']);
    expect(shown(all, view({ sort: { field: 'row.n', dir: 'desc' } }))).toEqual(['c', 'a', 'b', 'd']);
    expect(shown(all, view({ sort: { field: 'row.d', dir: 'asc' } }))).toEqual(['a', 'b', 'c', 'd']);
    expect(shown(all, view({ sort: { field: 'row.d', dir: 'desc' } }))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('reads the first row that survived a row filter', () => {
    const two = f('two', { rows: [{ n: 1, k: 'x' }, { n: 50, k: 'y' }] });
    const one = f('one', { rows: [{ n: 20, k: 'y' }] });
    const v = view({ filters: [{ field: 'row.k', values: ['y'] }], sort: { field: 'row.n', dir: 'asc' } });
    expect(shown([two, one], v)).toEqual(['one', 'two']);
  });

  it('breaks a tie with the sort named in then', () => {
    const v = view({ sort: { field: 'severity', dir: 'asc', then: { field: 'lastSeen', dir: 'desc' } } });
    const early = f('early', { severity: 'high', lastSeenAt: '2026-10-01T00:00:00.000Z' });
    const late = f('late', { severity: 'high', lastSeenAt: '2026-10-05T00:00:00.000Z' });
    expect(shown([early, late], v)).toEqual(['late', 'early']);
  });
});

describe('paging', () => {
  const many = Array.from({ length: 120 }, (_, i) => f(`f${String(i).padStart(3, '0')}`));
  const byName = (page: number, pageSize = 50) => applyView(many, view({ page, pageSize, sort: { field: 'resourceName', dir: 'asc' } }));

  it('returns one page, the total across all pages, and the page count', () => {
    const second = byName(2);
    expect(second.items).toHaveLength(50);
    expect(second.items[0].finding.fingerprint).toBe('f050');
    expect(second.total).toBe(120);
    expect(second.pageCount).toBe(3);
    expect(second.matched).toHaveLength(120);
    expect(byName(3).items).toHaveLength(20);
  });

  it('clamps a page past the end to the last page, and one before the start to the first', () => {
    expect(byName(99).page).toBe(3);
    expect(byName(0).page).toBe(1);
  });

  it('is one empty page when nothing matches', () => {
    const page = applyView(many, view({ filters: [{ field: 'category', values: ['nope'] }] }));
    expect(page).toMatchObject({ items: [], total: 0, page: 1, pageCount: 1 });
  });

  it('pages by the size asked for', () => {
    expect(byName(1, 10).items).toHaveLength(10);
    expect(byName(1, 10).pageCount).toBe(12);
  });
});

describe('the URL', () => {
  const REPRESENTATIVE: View[] = [
    emptyView(),
    view({ filters: [{ field: 'category', values: ['security', 'cost'] }, { field: 'severity', values: ['critical', 'high'] }, { field: 'status', values: ['new'] }] }),
    view({ filters: [
      { field: 'rule', values: ['rule-a'] }, { field: 'kind', values: ['advisory'] }, { field: 'subscription', values: ['sub-1'] },
      { field: 'resourceGroup', values: ['rg-1'] }, { field: 'location', values: ['westeurope'] }, { field: 'resourceType', values: ['microsoft.compute/virtualmachines'] },
      { field: 'resourceName', values: ['vm|1', 'a=b,c'] }, { field: 'tags', values: ['retirement'] },
      { field: 'firstSeen', values: ['2026-10-06'] }, { field: 'lastSeen', values: ['2026-10-07'] },
    ] }),
    view({ filters: [
      { field: 'row.feature', values: ['Basic IP', 'Old|API', 'a~b'] },
      { field: 'row.properties.sku', values: ['ba se'] },
      { field: 'row.note', values: ['50% off', 'a=b,c', 'back\\slash', 'x&y', 'ü ☃'] },
      { field: 'row.empty', values: [''] },
    ] }),
    view({ columns: ['feature', 'properties.sku', 'a,b'], sort: { field: 'row.retirementDate', dir: 'desc' }, page: 3 }),
    view({ sort: { field: 'lastSeen', dir: 'asc' }, window: { mode: 'relative', days: 30 }, search: 'vm 1 & more' }),
    view({ window: { mode: 'custom', from: '2026-01-01', to: '2026-01-31' } }),
  ];

  it('round-trips a representative set of views', () => {
    for (const v of REPRESENTATIVE) {
      expect(viewFromSearchParams(viewToSearchParams(v))).toEqual(v);
      expect(viewFromSearchParams(new URLSearchParams(viewToSearchParams(v).toString()))).toEqual(v);
    }
  });

  it('writes the existing short names, and the new ones for columns, sort, row filters and page', () => {
    const params = viewToSearchParams(view({
      filters: [
        { field: 'category', values: ['security'] }, { field: 'rule', values: ['r1', 'r2'] }, { field: 'resourceGroup', values: ['rg-1'] },
        { field: 'row.feature', values: ['Old API'] },
      ],
      columns: ['feature', 'date'], sort: { field: 'row.date', dir: 'desc' }, page: 2, search: 'vm',
      window: { mode: 'relative', days: 30 },
    }), { tab: 'advisories' });
    expect(params.toString()).toBe(new URLSearchParams({
      tab: 'advisories', ruleId: 'r1,r2', category: 'security', rg: 'rg-1', window: '30', q: 'vm',
      cols: 'feature,date', sort: 'row.date:desc', rf: 'feature=Old API', page: '2',
    }).toString());
  });

        it('writes a plain value with a space readably, never double-encoded', () => {
          const text = viewToSearchParams(view({
            filters: [{ field: 'row.feature', values: ['Basic IP'] }, { field: 'resourceName', values: ['my vm'] }],
            columns: ['Retirement date'],
          })).toString();
          expect(text).toContain('Basic+IP');
          expect(text).toContain('my+vm');
          expect(text).toContain('Retirement+date');
          expect(text).not.toContain('%25');
        });

        it('round-trips a value holding spaces, %, |, =, a comma and a backslash, as a string and as a record', () => {
          const awkward = ['50% off', 'a|b', 'x=y', 'p,q', 'c:\\temp', 'all of it: 100% | a=b, c\\d'];
          const v = view({
            filters: [
              { field: 'row.some=odd,path|name', values: awkward },
              { field: 'resourceName', values: awkward },
              { field: 'tags', values: awkward },
              { field: 'location', values: awkward },
            ],
            columns: ['some=odd,path|name', '100%'],
          });
          const text = viewToSearchParams(v).toString();
          const back = viewFromSearchParams(new URLSearchParams(text));
          // Built-in fields come back in BUILTIN_FIELDS order, so compare as a set of filters.
          expect(back.filters).toEqual(expect.arrayContaining(v.filters));
          expect(back.filters).toHaveLength(v.filters.length);
          expect(back.columns).toEqual(v.columns);
          const asRecord: Record<string, string[]> = {};
          for (const [k, val] of new URLSearchParams(text)) (asRecord[k] ??= []).push(val);
          expect(viewFromSearchParams(asRecord)).toEqual(back);
        });

        it('opens a hand-written link with a bare % instead of dropping it', () => {
          const v = viewFromSearchParams(new URLSearchParams('rf=feature=50% off&cols=100%&tags=50%25 off&f=resourceName=100%|a'));
          expect(v.filters).toContainEqual({ field: 'row.feature', values: ['50% off'] });
          expect(v.filters).toContainEqual({ field: 'resourceName', values: ['100%', 'a'] });
          expect(v.columns).toEqual(['100%']);
          expect(viewFromSearchParams({ rf: 'feature=50% off', cols: '%E0%A4%A' }).filters).toEqual([{ field: 'row.feature', values: ['50% off'] }]);
          expect(viewFromSearchParams({ cols: '%E0%A4%A' }).columns).toEqual(['%E0%A4%A']);
        });

        it('round-trips every filter a header funnel or the Add filter control can set', () => {
          const v = view({
            filters: [
              { field: 'rule', values: ['rule-a', 'cred:app-secret-expiring'] },
              { field: 'category', values: ['security'] },
              { field: 'severity', values: ['critical'] },
              { field: 'resourceName', values: ['vm 1', 'vm,2'] },
              { field: 'firstSeen', values: ['2026-10-06', '2026-10-01'] },
              ...GENERIC_FIELDS.filter(f => f !== 'resourceName' && f !== 'firstSeen').map(field => ({ field, values: ['a b', 'c|d'] })),
            ],
            sort: { field: 'resourceName', dir: 'desc' },
          });
          const back = viewFromSearchParams(viewToSearchParams(v));
          expect(back.filters).toEqual(expect.arrayContaining(v.filters));
          expect(back.filters).toHaveLength(v.filters.length);
          expect(back.sort).toEqual(v.sort);
        });

  it('leaves defaults out, so a default view is an empty query', () => {
    expect(viewToSearchParams(emptyView()).toString()).toBe('');
    expect(viewToSearchParams(view({ page: 1, window: { mode: 'relative', days: 7 }, filters: [{ field: 'status', values: ['open'] }] })).toString()).toBe('');
  });

  it('reads the page the server page hands over as a plain object, repeated rf included', () => {
    const v = viewFromSearchParams({ tab: 'results', severity: 'high', rf: ['feature=A', 'date=2026|2027'], page: '4', cols: undefined });
    expect(v.filters).toEqual([
      { field: 'severity', values: ['high'] },
      { field: 'row.feature', values: ['A'] },
      { field: 'row.date', values: ['2026', '2027'] },
    ]);
    expect(v.page).toBe(4);
  });

  it('ignores an unknown or malformed param instead of throwing', () => {
    const v = viewFromSearchParams(new URLSearchParams({
      severity: 'high,bogus', status: 'nonsense', sort: 'nofield', page: 'abc', window: '-3', from: 'x', to: 'y',
      cols: '%E0%A4%A,ok', rf: '=novalue', mystery: '1',
    }));
    expect(v.filters).toEqual([{ field: 'severity', values: ['high'] }]);
    expect(v.sort).toBeNull();
    expect(v.page).toBe(1);
    expect(v.window).toEqual({ mode: 'relative', days: 7 });
    expect(v.columns).toEqual(['%E0%A4%A', 'ok']);
    expect(() => viewFromSearchParams(new URLSearchParams('f=kind&f==x&f=bogus=1&rf=%ZZ&sort=:asc&sort=row.:asc'))).not.toThrow();
  });

  it('reads the removed "active" status as open, like the explorer always has', () => {
    expect(viewFromSearchParams({ status: 'active' }).filters).toEqual([]);
  });

  it('rejects a sort on a field that is neither built-in nor a returned column', () => {
    expect(viewFromSearchParams({ sort: 'bogus:asc' }).sort).toBeNull();
    expect(viewFromSearchParams({ sort: 'row.a.b:desc' }).sort).toEqual({ field: 'row.a.b', dir: 'desc' });
  });
});

describe('lib/finding-view.ts stays client-safe', () => {
  it('imports no drizzle, db, node or next module', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'finding-view.ts'), 'utf8');
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec, `${spec} must be a sibling lib module`).toMatch(/^\.\/[\w-]+$/);
      expect(spec).not.toMatch(/\/db(\/|$)/);
    }
  });
});
