/**
 * Grouping in the view engine (ADR 0006, #195), driven through its public functions only: findings
 * with rows and a View go in, a tree of groups with resource and row counts comes out. Covers nested
 * grouping, a resource under two groups, the empty-value group last, sort by value or count, paging
 * of groups and of the rows inside one, grouping combined with returned-column filters, the Service
 * retirements workbook, and the `group` / `gsort` URL params.
 */
import { describe, expect, it } from 'vitest';
import {
  applyGroupedView, emptyView, pageGroupItems, viewFromSearchParams, viewToSearchParams,
  type View, type ViewFinding, type ViewGroup,
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

/** A group as `value|resources|rows`, null as `∅`, with its children indented under it. */
function outline(groups: ViewGroup<F>[], depth = 0): string[] {
  return groups.flatMap(g => [
    `${'  '.repeat(depth)}${g.value ?? '∅'}|${g.resourceCount}|${g.rowCount}`,
    ...outline(g.groups, depth + 1),
  ]);
}
const names = (group: ViewGroup<F>) => group.items.map(i => i.finding.fingerprint);

// The Service retirements rule's own columns: one VM with two retirements, several sharing one.
const retire = (retiringFeature: string, retirementDate: string) => ({ retiringFeature, retirementDate });
const vmTwo = f('vm-two', { rows: [retire('Basic IP', '2026-09-30'), retire('Old API', '2027-03-31')] });
const vmB = f('vm-b', { rows: [retire('Old API', '2027-03-31')] });
const vmC = f('vm-c', { rows: [retire('Old API', '2027-03-31')] });
const vmD = f('vm-d', { rows: [retire('Old API', '2028-01-01')] });
const vmE = f('vm-e', { rows: [retire('Basic IP', '')] });
const retirements = [vmTwo, vmB, vmC, vmD, vmE];

describe('the Service retirements workbook: group by retiring feature, then retirement date', () => {
  const grouped = applyGroupedView(retirements, view({ groupBy: ['row.retiringFeature', 'row.retirementDate'] }));

  it('gives each group its resource count and row count, nested in order, with the empty date last', () => {
    expect(outline(grouped.groups)).toEqual([
      'Basic IP|2|2',
      '  2026-09-30|1|1',
      '  ∅|1|1',
      'Old API|4|4',
      '  2027-03-31|3|3',
      '  2028-01-01|1|1',
    ]);
  });

  it('lists the VM with two retirements under both of its features, with only the row that fell there', () => {
    const [basic, old] = grouped.groups;
    expect(names(basic.groups[0])).toEqual(['vm-two']);
    expect(basic.groups[0].items[0].rows).toEqual([retire('Basic IP', '2026-09-30')]);
    expect(names(old.groups[0]).sort()).toEqual(['vm-b', 'vm-c', 'vm-two']);
    expect(old.groups[0].items.find(i => i.finding.fingerprint === 'vm-two')!.rows).toEqual([retire('Old API', '2027-03-31')]);
  });

  it('counts a finding once per group, not once per row', () => {
    const twice = f('twice', { rows: [{ k: 'x', n: 1 }, { k: 'x', n: 2 }, { k: 'y', n: 3 }] });
    const [x, y] = applyGroupedView([twice], view({ groupBy: ['row.k'] })).groups;
    expect([x.value, x.resourceCount, x.rowCount]).toEqual(['x', 1, 2]);
    expect([y.value, y.resourceCount, y.rowCount]).toEqual(['y', 1, 1]);
  });

  it('reports the findings and rows that matched, across every group', () => {
    expect(grouped.total).toBe(5);
    expect(grouped.rowTotal).toBe(6);
  });

  it('has no child groups at the last level, and no items above it', () => {
    expect(grouped.groups[0].items).toEqual([]);
    expect(grouped.groups[0].groups[0].groups).toEqual([]);
  });
});

describe('sorting groups', () => {
  const sizes = [
    f('a1', { rows: [{ k: 'small' }] }),
    f('a2', { rows: [{ k: 'big' }] }), f('a3', { rows: [{ k: 'big' }] }), f('a4', { rows: [{ k: 'big' }] }),
    f('a5', { rows: [{ k: 'mid' }] }), f('a6', { rows: [{ k: 'mid' }] }),
    f('a7', { rows: [{ k: '' }] }), f('a8', { rows: [{ k: '' }] }), f('a9', { rows: [{ k: '' }] }), f('a10', { rows: [{}] }),
  ];
  const order = (groupSort: View['groupSort']) => applyGroupedView(sizes, view({ groupBy: ['row.k'], groupSort })).groups.map(g => g.value);

  it('sorts by value, ascending by default and descending on request', () => {
    expect(order({ by: 'value', dir: 'asc' })).toEqual(['big', 'mid', 'small', null]);
    expect(order({ by: 'value', dir: 'desc' })).toEqual(['small', 'mid', 'big', null]);
  });

  it('sorts by resource count, the empty-value group last even when it is the biggest', () => {
    expect(order({ by: 'count', dir: 'desc' })).toEqual(['big', 'mid', 'small', null]);
    expect(order({ by: 'count', dir: 'asc' })).toEqual(['small', 'mid', 'big', null]);
  });

  it('breaks equal counts by value, so the order does not depend on arrival order', () => {
    const tied = [f('t1', { rows: [{ k: 'b' }] }), f('t2', { rows: [{ k: 'a' }] })];
    const groups = (list: F[], dir: 'asc' | 'desc') => applyGroupedView(list, view({ groupBy: ['row.k'], groupSort: { by: 'count', dir } })).groups.map(g => g.value);
    expect(groups(tied, 'desc')).toEqual(['a', 'b']);
    expect(groups([...tied].reverse(), 'asc')).toEqual(['a', 'b']);
  });

  it('applies the group sort at every level', () => {
    const rows = [f('x', { rows: [{ a: '1', b: 'p' }, { a: '1', b: 'q' }, { a: '2', b: 'q' }] }), f('y', { rows: [{ a: '1', b: 'q' }] })];
    const grouped = applyGroupedView(rows, view({ groupBy: ['row.a', 'row.b'], groupSort: { by: 'count', dir: 'desc' } }));
    expect(outline(grouped.groups)).toEqual(['1|2|3', '  q|2|2', '  p|1|1', '2|1|1', '  q|1|1']);
  });

  it('orders numbers and dates as people read them', () => {
    const nums = ['10', '9', '2'].map(n => f(`n${n}`, { rows: [{ n }] }));
    expect(applyGroupedView(nums, view({ groupBy: ['row.n'] })).groups.map(g => g.value)).toEqual(['2', '9', '10']);
  });

  it('sorts the findings inside the last group by the view sort', () => {
    const list = [f('vm-b', { severity: 'low', rows: [{ k: 'x' }] }), f('vm-a', { severity: 'high', rows: [{ k: 'x' }] })];
    const items = (sort: View['sort']) => names(applyGroupedView(list, view({ groupBy: ['row.k'], sort })).groups[0]);
    expect(items(null)).toEqual(['vm-a', 'vm-b']);
    expect(items({ field: 'resourceName', dir: 'desc' })).toEqual(['vm-b', 'vm-a']);
  });
});

describe('grouping by a built-in field', () => {
  it('puts a finding under its one value with all of its rows', () => {
    const list = [f('a', { location: 'westeurope', rows: [{ n: 1 }, { n: 2 }] }), f('b', { location: 'northeurope', rows: [{ n: 3 }] })];
    expect(outline(applyGroupedView(list, view({ groupBy: ['location'] })).groups)).toEqual(['northeurope|1|1', 'westeurope|1|2']);
  });

  it('puts a finding under each of its tags, and one with none in the empty group', () => {
    const list = [f('a', { ruleTags: ['t1', 't2'] }), f('b', { ruleTags: ['t2'] }), f('c', { ruleTags: [] })];
    const grouped = applyGroupedView(list, view({ groupBy: ['tags'] }));
    expect(outline(grouped.groups)).toEqual(['t1|1|0', 't2|2|0', '∅|1|0']);
    expect(grouped.total).toBe(3);
  });

  it('keeps a finding that holds no rows in a returned-column group, as the empty value', () => {
    const grouped = applyGroupedView([f('bare', { rows: [] })], view({ groupBy: ['row.k'] }));
    expect(outline(grouped.groups)).toEqual(['∅|1|0']);
    expect(names(grouped.groups[0])).toEqual(['bare']);
  });

  it('mixes a built-in and a returned field in one nest', () => {
    const list = [f('a', { severity: 'high', rows: [{ k: 'x' }, { k: 'y' }] }), f('b', { severity: 'low', rows: [{ k: 'x' }] })];
    const grouped = applyGroupedView(list, view({ groupBy: ['row.k', 'severity'] }));
    expect(outline(grouped.groups)).toEqual(['x|2|2', '  high|1|1', '  low|1|1', 'y|1|1', '  high|1|1']);
  });

  it('reads a nested returned column by dot path and shows an object as compact JSON', () => {
    const list = [f('a', { rows: [{ properties: { sku: 'basic' }, tags: { env: 'prod' } }] })];
    expect(outline(applyGroupedView(list, view({ groupBy: ['row.properties.sku'] })).groups)).toEqual(['basic|1|1']);
    expect(outline(applyGroupedView(list, view({ groupBy: ['row.tags'] })).groups)).toEqual(['{"env":"prod"}|1|1']);
  });
});

describe('grouping with filters', () => {
  it('buckets only the rows that pass a returned-column filter', () => {
    const grouped = applyGroupedView(retirements, view({
      filters: [{ field: 'row.retiringFeature', values: ['Old API'] }],
      groupBy: ['row.retirementDate'],
    }));
    expect(outline(grouped.groups)).toEqual(['2027-03-31|3|3', '2028-01-01|1|1']);
    expect(grouped.total).toBe(4);
    expect(grouped.rowTotal).toBe(4);
  });

  it('drops a finding with no matching row, and leaves its other rows out of every group', () => {
    const grouped = applyGroupedView(retirements, view({
      filters: [{ field: 'row.retirementDate', values: ['2026-09-30'] }],
      groupBy: ['row.retiringFeature'],
    }));
    expect(outline(grouped.groups)).toEqual(['Basic IP|1|1']);
    expect(grouped.groups[0].items[0].rows).toEqual([retire('Basic IP', '2026-09-30')]);
  });

  it('applies built-in filters before grouping', () => {
    const list = [f('a', { severity: 'high', rows: [{ k: 'x' }] }), f('b', { severity: 'low', rows: [{ k: 'x' }] })];
    const grouped = applyGroupedView(list, view({ filters: [{ field: 'severity', values: ['high'] }], groupBy: ['row.k'] }));
    expect(outline(grouped.groups)).toEqual(['x|1|1']);
  });

  it('is empty when nothing matches', () => {
    const grouped = applyGroupedView(retirements, view({ filters: [{ field: 'row.retiringFeature', values: ['Nothing'] }], groupBy: ['row.retirementDate'] }));
    expect(grouped).toMatchObject({ groups: [], groupTotal: 0, total: 0, rowTotal: 0, page: 1, pageCount: 1 });
  });

  it('groups nothing when the view has no groupBy, so the flat list stays applyView', () => {
    expect(applyGroupedView(retirements, view()).groups).toEqual([]);
  });
});

describe('sorting groups by value follows what the header shows', () => {
  const order = (list: F[], field: 'rule' | 'severity' | 'category' | 'subscription', dir: 'asc' | 'desc', labelFor?: (field: string, value: string) => string) =>
    applyGroupedView(list, view({ groupBy: [field], groupSort: { by: 'value', dir } }), {}, { labelFor }).groups.map(g => g.value);

  it('orders rule groups by rule name, not by rule id', () => {
    const rules = [
      f('r1', { ruleId: 'aa-2', policyName: 'Zulu' }),
      f('r2', { ruleId: 'zz-1', policyName: 'Alpha' }),
      f('r3', { ruleId: 'mm-3', policyName: 'Mike' }),
    ];
    const ruleNames: Record<string, string> = { 'aa-2': 'Zulu', 'zz-1': 'Alpha', 'mm-3': 'Mike' };
    const labelFor = (_field: string, value: string) => ruleNames[value] ?? value;
    expect(order(rules, 'rule', 'asc', labelFor)).toEqual(['zz-1', 'mm-3', 'aa-2']);
    expect(order(rules, 'rule', 'desc', labelFor)).toEqual(['aa-2', 'mm-3', 'zz-1']);
  });

  it('falls back to the stored value when no labelFor is given', () => {
    const rules = [f('r1', { ruleId: 'zz-1', policyName: 'Alpha' }), f('r2', { ruleId: 'aa-2', policyName: 'Zulu' })];
    expect(order(rules, 'rule', 'asc')).toEqual(['aa-2', 'zz-1']);
  });

  it('orders category and subscription groups by their labels, the empty group still last both ways', () => {
    const subs = [
      f('s1', { subscriptionId: 'sub-a' }), f('s2', { subscriptionId: 'sub-b' }), f('s3', { subscriptionId: '' }),
    ];
    const labelFor = (_field: string, value: string) => ({ 'sub-a': 'Production', 'sub-b': 'Development' })[value] ?? value;
    expect(order(subs, 'subscription', 'asc', labelFor)).toEqual(['sub-b', 'sub-a', null]);
    expect(order(subs, 'subscription', 'desc', labelFor)).toEqual(['sub-a', 'sub-b', null]);

    const cats = [f('c1', { category: 'cost' }), f('c2', { category: 'security' })];
    const catLabel = (_field: string, value: string) => ({ cost: 'Z cost', security: 'A security' })[value] ?? value;
    expect(order(cats, 'category', 'asc', catLabel)).toEqual(['security', 'cost']);
  });

  it('orders severity groups along the ramp, critical first, anything off the ramp last', () => {
    const sevs = (['low', 'critical', 'info', 'medium', 'high', 'unrated'] as const)
      .map((severity, i) => f(`v${i}`, { severity: severity as F['severity'] }));
    expect(order(sevs, 'severity', 'asc')).toEqual(['critical', 'high', 'medium', 'low', 'info', 'unrated']);
    expect(order(sevs, 'severity', 'desc')).toEqual(['unrated', 'info', 'low', 'medium', 'high', 'critical']);
  });
});

describe('paging', () => {
  const many = Array.from({ length: 120 }, (_, i) => f(`vm${String(i).padStart(3, '0')}`, { rows: [{ k: String(i % 7).padStart(2, '0') }] }));

  it('pages the top-level groups by the view page and size', () => {
    const page = (n: number, pageSize: number) => applyGroupedView(many, view({ groupBy: ['row.k'], page: n, pageSize }));
    expect(page(1, 3).groups.map(g => g.value)).toEqual(['00', '01', '02']);
    expect(page(2, 3).groups.map(g => g.value)).toEqual(['03', '04', '05']);
    expect(page(3, 3).groups.map(g => g.value)).toEqual(['06']);
    expect(page(1, 3)).toMatchObject({ groupTotal: 7, pageCount: 3, total: 120 });
    expect(page(99, 3).page).toBe(3);
    expect(page(0, 3).page).toBe(1);
  });

  it('pages the rows inside a group 50 at a time, on that group\'s own page number', () => {
    const big = Array.from({ length: 2000 }, (_, i) => f(`r${String(i).padStart(4, '0')}`, { rows: [{ k: 'retiring' }] }));
    const [retiring] = applyGroupedView(big, view({ groupBy: ['row.k'], sort: { field: 'resourceName', dir: 'asc' } })).groups;
    expect(retiring.resourceCount).toBe(2000);
    const first = pageGroupItems(retiring.items, 1);
    expect(first.items).toHaveLength(50);
    expect(first).toMatchObject({ total: 2000, page: 1, pageCount: 40 });
    const third = pageGroupItems(retiring.items, 3);
    expect(third.items[0].finding.fingerprint).toBe('r0100');
    expect(pageGroupItems(retiring.items, 40).items).toHaveLength(50);
    expect(pageGroupItems(retiring.items, 41).page).toBe(40);
    expect(pageGroupItems([], 5)).toEqual({ items: [], total: 0, page: 1, pageCount: 1 });
  });
});

describe('the group params in the URL', () => {
  it('writes group as a comma list and gsort only when it is not value ascending', () => {
    const params = viewToSearchParams(view({ groupBy: ['row.retiringFeature', 'row.retirementDate'] }), { tab: 'advisories' });
    expect(params.toString()).toBe(new URLSearchParams({ tab: 'advisories', group: 'row.retiringFeature,row.retirementDate' }).toString());
    const counted = viewToSearchParams(view({ groupBy: ['severity'], groupSort: { by: 'count', dir: 'desc' } }));
    expect(counted.toString()).toBe(new URLSearchParams({ group: 'severity', gsort: 'count:desc' }).toString());
    expect(viewToSearchParams(view({ groupSort: { by: 'value', dir: 'asc' } })).toString()).toBe('');
  });

  it('round-trips grouping, a field with a comma or equals sign in it, and a non-default gsort', () => {
    const views = [
      view({ groupBy: ['location'] }),
      view({ groupBy: ['row.retiringFeature', 'row.retirementDate', 'tags'], groupSort: { by: 'count', dir: 'asc' } }),
      view({ groupBy: ['row.odd,na=me|x\\y', 'severity'], groupSort: { by: 'value', dir: 'desc' } }),
      view({ groupBy: ['severity'], filters: [{ field: 'row.k', values: ['a b'] }], columns: ['k'], sort: { field: 'row.k', dir: 'desc' }, page: 3 }),
    ];
    for (const v of views) {
      expect(viewFromSearchParams(viewToSearchParams(v))).toEqual(v);
      expect(viewFromSearchParams(new URLSearchParams(viewToSearchParams(v).toString()))).toEqual(v);
    }
  });

  it('reads the page handed over as a plain object', () => {
    const v = viewFromSearchParams({ tab: 'results', group: 'row.a,severity', gsort: 'count:desc' });
    expect(v.groupBy).toEqual(['row.a', 'severity']);
    expect(v.groupSort).toEqual({ by: 'count', dir: 'desc' });
  });

  it('ignores a malformed group or gsort instead of throwing', () => {
    const v = viewFromSearchParams(new URLSearchParams({ group: 'bogus,severity,row.,severity,,%ZZ', gsort: 'sideways:up' }));
    expect(v.groupBy).toEqual(['severity']);
    expect(v.groupSort).toEqual({ by: 'value', dir: 'asc' });
    expect(viewFromSearchParams({ gsort: 'count' }).groupSort).toEqual({ by: 'value', dir: 'asc' });
    expect(viewFromSearchParams({ gsort: 'count:' }).groupSort).toEqual({ by: 'value', dir: 'asc' });
    expect(viewFromSearchParams({}).groupBy).toEqual([]);
  });
});
