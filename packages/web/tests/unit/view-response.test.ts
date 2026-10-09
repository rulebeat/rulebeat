/**
 * ADR 0007: the pure reference for what a view's routes answer. It is built only from
 * the engine's own functions, so these tests pin it with known literals: a specific total, tile count,
 * facet count and column list, over a small set of findings whose answers can be counted by hand.
 */
import { describe, expect, it } from 'vitest';
import {
  buildColumnValuesResponse, buildFindingRowsResponse, buildGroupResponse, buildViewResponse, decorateFinding, rulesInPlay,
  type ViewResponseOptions,
} from '@/lib/view-response';
import { emptyView, rowField, type View } from '@/lib/finding-view';
import type { ExplorerFinding } from '@/lib/explorer-data';
import type { FindingRow } from '@/lib/finding-rows';

// A fixed window, so nothing here depends on the day the test runs.
const RANGE = { from: '2026-10-03', to: '2026-10-09' };
const CTX = { range: RANGE };

function finding(over: Partial<ExplorerFinding> & { fingerprint: string; ruleId: string }, rows: FindingRow[] = []): ExplorerFinding {
  return {
    module: 'cost', category: 'cost', severity: 'medium', kind: 'state', subscriptionId: 's1', resourceGroup: 'rg1', location: 'westeurope',
    resourceType: 'microsoft.compute/virtualmachines', resourceName: over.fingerprint, resourceId: `/subscriptions/s1/${over.fingerprint}`,
    title: 'T', description: '', recommendation: '', remediationSteps: [], detectedAt: '2026-10-01T00:00:00.000Z',
    status: 'active', firstSeenAt: '2026-09-01T00:00:00.000Z', lastSeenAt: '2026-10-08T00:00:00.000Z', timesSeen: 1,
    policyName: over.ruleId === 'r1' ? 'Rule One' : over.ruleId === 'r2' ? 'Rule Two' : 'Rule Three', ruleDisabled: false, ruleTags: [],
    rows, ...over,
  };
}

const MANY_ROWS: FindingRow[] = Array.from({ length: 25 }, (_, i) => ({ sku: `bulk-${String(i).padStart(2, '0')}` }));

const FINDINGS: ExplorerFinding[] = [
  finding({ fingerprint: 'a', ruleId: 'r1', severity: 'high', firstSeenAt: '2026-10-08T00:00:00.000Z', ruleTags: ['t1'] }, [{ sku: 'S1', zone: '1' }, { sku: 'S2' }, { sku: 'S1', zone: '' }]),
  finding({ fingerprint: 'b', ruleId: 'r1', severity: 'medium', resourceGroup: 'rg2', location: 'northeurope', ruleTags: ['t1', 't2'] }, [{ sku: 'S2' }]),
  finding({ fingerprint: 'c', ruleId: 'r2', category: 'security', severity: 'critical', subscriptionId: 's2' }, []),
  finding({ fingerprint: 'd', ruleId: 'r2', category: 'security', severity: 'low', subscriptionId: 's2', status: 'fixed', resolvedAt: '2026-10-07T00:00:00.000Z' }, [{ sku: 'S9' }]),
  finding({ fingerprint: 'e', ruleId: 'r3', category: 'security', severity: 'info', kind: 'activity', lastSeenAt: '2026-10-09T01:00:00.000Z', resourceName: undefined, resourceId: undefined, resourceGroup: undefined, location: undefined, dimensionKey: 'sign-in' }, [{ sku: 'S2' }]),
  finding({ fingerprint: 'f', ruleId: 'r1', severity: 'medium', status: 'active' }, MANY_ROWS),
];

const OPTS: ViewResponseOptions = {
  tab: 'results',
  catalogueColumns: ['sku', 'zone'],
  categories: [{ id: 'cost', label: 'Cost' }, { id: 'security', label: 'Security' }],
};

const view = (over: Partial<View> = {}): View => ({ ...emptyView(), ...over });

describe('buildViewResponse', () => {
  it('answers the default view: open findings, tiles, facets, rule rows and columns', () => {
    const res = buildViewResponse(FINDINGS, view(), CTX, OPTS);

    expect(res.tab).toBe('results');
    expect(res.kinds).toEqual(['state', 'activity']);
    expect(res.total).toBe(5);
    expect([res.page, res.pageCount, res.pageSize]).toEqual([1, 1, 50]);
    // Most severe first, severity ties in the order the findings arrived in.
    expect(res.items.map(i => i.finding.fingerprint)).toEqual(['c', 'a', 'b', 'f', 'e']);
    // The Results tiles count Problems only, and only 'a' appeared inside the window.
    expect(res.tiles).toEqual({
      total: 4, counts: { critical: 1, high: 1, medium: 2, low: 0, info: 0 }, newCount: 1, activeCount: 3, recentlyFixedCount: 1,
    });
    expect(res.facets.severity).toEqual([
      { value: 'critical', label: 'critical', count: 1 }, { value: 'high', label: 'high', count: 1 },
      { value: 'medium', label: 'medium', count: 2 }, { value: 'info', label: 'info', count: 1 },
    ]);
    // Each facet leaves its own filter out, so the status facet is not in the list at all.
    expect(res.facets).not.toHaveProperty('status');
    expect(res.facets.tags).toEqual([{ value: 't1', label: 't1', count: 2 }, { value: 't2', label: 't2', count: 1 }]);
    expect(res.ruleRows).toEqual([
      { ruleId: 'r1', name: 'Rule One', category: 'cost', severity: 'high', disabled: false, open: 3, new: 1, fixed: 0, findingCount: 3 },
      { ruleId: 'r2', name: 'Rule Two', category: 'security', severity: 'critical', disabled: false, open: 1, new: 0, fixed: 1, findingCount: 1 },
      { ruleId: 'r3', name: 'Rule Three', category: 'security', severity: 'info', disabled: false, open: 0, new: 0, fixed: 0, findingCount: 1 },
    ]);
    expect(res.columns).toEqual(['sku', 'zone']);
    expect(res.suppressedCount).toBe(0);
    expect(res.lastScanAt).toBe('2026-10-09T01:00:00.000Z');
    expect(res.policyOptions).toEqual([
      { id: 'r1', name: 'Rule One', category: 'cost' }, { id: 'r3', name: 'Rule Three', category: 'security' }, { id: 'r2', name: 'Rule Two', category: 'security' },
    ]);
    expect(res.categories).toEqual(OPTS.categories);
    expect(res.grouped).toBeNull();
  });

  it('sends the first 20 matched rows of a finding with the counts, never the full rows', () => {
    const res = buildViewResponse(FINDINGS, view(), CTX, OPTS);
    const bulk = res.items.find(i => i.finding.fingerprint === 'f')!;
    expect(bulk.rows).toHaveLength(20);
    expect(bulk.rows[19]).toEqual({ sku: 'bulk-19' });
    expect([bulk.rowCount, bulk.matchedRowCount]).toEqual([25, 25]);
    expect(bulk.finding).not.toHaveProperty('rows');
    expect(bulk.finding).not.toHaveProperty('evidence');
  });

  it('keeps only the rows that pass a row filter, and drops a finding with none', () => {
    const res = buildViewResponse(FINDINGS, view({ filters: [{ field: rowField('sku'), values: ['S1'] }] }), CTX, OPTS);
    expect(res.total).toBe(1);
    expect(res.items[0].finding.fingerprint).toBe('a');
    expect(res.items[0].rows).toEqual([{ sku: 'S1', zone: '1' }, { sku: 'S1', zone: '' }]);
    expect([res.items[0].rowCount, res.items[0].matchedRowCount]).toEqual([3, 2]);
  });

  it('counts every status, hides suppressed findings and says how many are hidden', () => {
    const all = buildViewResponse(FINDINGS, view({ filters: [{ field: 'status', values: ['all'] }] }), CTX, OPTS);
    expect(all.total).toBe(6);
    const fixed = buildViewResponse(FINDINGS, view({ filters: [{ field: 'status', values: ['fixed'] }] }), CTX, OPTS);
    expect(fixed.items.map(i => i.finding.fingerprint)).toEqual(['d']);

    const suppressed = new Set(['b', 'c']);
    const hidden = buildViewResponse(FINDINGS, view(), { ...CTX, suppressedFingerprints: suppressed }, OPTS);
    expect(hidden.total).toBe(3);
    expect(hidden.suppressedCount).toBe(2);
    const shown = buildViewResponse(FINDINGS, view(), { ...CTX, suppressedFingerprints: suppressed, showSuppressed: true }, OPTS);
    expect(shown.total).toBe(5);
    // The count of hidden findings follows the category filter, as the explorer's banner does.
    const security = buildViewResponse(FINDINGS, view({ filters: [{ field: 'category', values: ['security'] }] }), { ...CTX, suppressedFingerprints: suppressed }, OPTS);
    expect(security.suppressedCount).toBe(1);
  });

  it('pages the flat list and clamps a page past the end', () => {
    const res = buildViewResponse(FINDINGS, view({ pageSize: 2, page: 9 }), CTX, OPTS);
    expect([res.page, res.pageCount, res.pageSize, res.total]).toEqual([3, 3, 2, 5]);
    expect(res.items.map(i => i.finding.fingerprint)).toEqual(['e']);
  });

  it('lists the catalogue columns and the picked ones, sorted, and a column no finding has stays empty', () => {
    const res = buildViewResponse(FINDINGS, view({ columns: ['nobody.has.this', 'zone'] }), CTX, OPTS);
    expect(res.columns).toEqual(['nobody.has.this', 'sku', 'zone']);
    const filtered = buildViewResponse(FINDINGS, view({ filters: [{ field: rowField('nobody.has.this'), values: ['x'] }] }), CTX, OPTS);
    expect(filtered.total).toBe(0);
    expect(filtered.items).toEqual([]);
  });

  it('answers a grouped view with group headers and counts, and no findings inside', () => {
    const res = buildViewResponse(FINDINGS, view({ groupBy: ['category', rowField('sku')] }), CTX, OPTS);
    expect(res.items).toEqual([]);
    expect(res.total).toBe(5);
    expect(res.grouped).toMatchObject({ groupTotal: 2, rowTotal: 30, page: 1, pageCount: 1 });
    expect(res.grouped!.groups).toEqual([
      { field: 'category', value: 'cost', label: 'Cost', resourceCount: 3, rowCount: 29 },
      { field: 'category', value: 'security', label: 'Security', resourceCount: 2, rowCount: 1 },
    ]);
  });
});

describe('rulesInPlay and decorateFinding', () => {
  it('lists each rule once, whatever the findings\' status', () => {
    expect(rulesInPlay(FINDINGS).sort()).toEqual(['r1', 'r2', 'r3']);
  });

  it('names a finding by its rule, and falls back to the finding\'s title for a rule that is gone', () => {
    const record = { ...FINDINGS[0], evidence: { sku: 'S1' } } as unknown as Parameters<typeof decorateFinding>[0];
    expect(decorateFinding(record, { name: 'Renamed', enabled: false, tags: ['x'] })).toMatchObject({ policyName: 'Renamed', ruleDisabled: true, ruleTags: ['x'] });
    const gone = decorateFinding(record, undefined);
    expect(gone).toMatchObject({ policyName: 'T', ruleDisabled: false, ruleTags: [] });
    expect(gone).not.toHaveProperty('evidence');
  });
});

describe('buildFindingRowsResponse', () => {
  it('pages one finding\'s matched rows 20 at a time', () => {
    const first = buildFindingRowsResponse(FINDINGS, view(), CTX, { tab: 'results', fingerprint: 'f', rowsPage: 1 })!;
    expect([first.rows.length, first.page, first.pageCount, first.matchedRowCount, first.rowCount, first.firstIndex]).toEqual([20, 1, 2, 25, 25, 0]);
    const second = buildFindingRowsResponse(FINDINGS, view(), CTX, { tab: 'results', fingerprint: 'f', rowsPage: 2 })!;
    expect(second.rows.map(r => r.sku)).toEqual(['bulk-20', 'bulk-21', 'bulk-22', 'bulk-23', 'bulk-24']);
    expect(second.firstIndex).toBe(20);
    const past = buildFindingRowsResponse(FINDINGS, view(), CTX, { tab: 'results', fingerprint: 'f', rowsPage: 99 })!;
    expect(past.page).toBe(2);
  });

  it('applies the view\'s row filters, and has no finding for an unknown fingerprint', () => {
    const res = buildFindingRowsResponse(FINDINGS, view({ filters: [{ field: rowField('sku'), values: ['S1'] }] }), CTX, { tab: 'results', fingerprint: 'a', rowsPage: 1 })!;
    expect(res.rows).toEqual([{ sku: 'S1', zone: '1' }, { sku: 'S1', zone: '' }]);
    expect([res.matchedRowCount, res.rowCount]).toEqual([2, 3]);
    expect(buildFindingRowsResponse(FINDINGS, view(), CTX, { tab: 'results', fingerprint: 'nope', rowsPage: 1 })).toBeNull();
  });
});

describe('buildGroupResponse', () => {
  it('lists the next level\'s headers inside a group', () => {
    const res = buildGroupResponse(FINDINGS, view({ groupBy: ['category', rowField('sku')] }), CTX, { ...OPTS, groupPath: ['cost'], groupPage: 1 });
    expect(res.group).toEqual({ field: 'category', value: 'cost', label: 'Cost', resourceCount: 3, rowCount: 29 });
    expect(res.items).toEqual([]);
    // 'a' has two S1 rows in one group and one S2; 'f' has 25 bulk values. Values order as text does
    // in a locale, so bulk-* comes before S1.
    expect(res.groups).toHaveLength(2 + 25);
    expect(res.groups[0]).toEqual({ field: 'row.sku', value: 'bulk-00', label: 'bulk-00', resourceCount: 1, rowCount: 1 });
    expect(res.groups.slice(-2)).toEqual([
      { field: 'row.sku', value: 'S1', label: 'S1', resourceCount: 1, rowCount: 2 },
      { field: 'row.sku', value: 'S2', label: 'S2', resourceCount: 2, rowCount: 2 },
    ]);
  });

  it('lists the findings of a last-level group, 50 to a page, each with the rows that fell there', () => {
    const res = buildGroupResponse(FINDINGS, view({ groupBy: ['category', rowField('sku')] }), CTX, { ...OPTS, groupPath: ['cost', 'S1'], groupPage: 1 });
    expect(res.groups).toEqual([]);
    expect(res.items.map(i => i.finding.fingerprint)).toEqual(['a']);
    expect(res.items[0].rows).toEqual([{ sku: 'S1', zone: '1' }, { sku: 'S1', zone: '' }]);
    expect([res.total, res.page, res.pageCount]).toEqual([1, 1, 1]);
  });

  it('reaches the empty-value group with null, and finds nothing for a group that does not exist', () => {
    const empty = buildGroupResponse(FINDINGS, view({ groupBy: [rowField('zone')] }), CTX, { ...OPTS, groupPath: [null], groupPage: 1 });
    expect(empty.group).toMatchObject({ value: null, label: 'No value' });
    // 'a' is here too: two of its rows have no zone.
    expect(empty.items.map(i => i.finding.fingerprint).sort()).toEqual(['a', 'b', 'c', 'e', 'f']);
    const missing = buildGroupResponse(FINDINGS, view({ groupBy: ['category'] }), CTX, { ...OPTS, groupPath: ['nowhere'], groupPage: 1 });
    expect(missing).toMatchObject({ group: null, groups: [], items: [], total: 0 });
    const tooDeep = buildGroupResponse(FINDINGS, view({ groupBy: ['category'] }), CTX, { ...OPTS, groupPath: ['cost', 'x'], groupPage: 1 });
    expect(tooDeep.group).toBeNull();
  });
});

describe('buildColumnValuesResponse', () => {
  it('lists a column\'s values by how many findings hold them, most first', () => {
    const res = buildColumnValuesResponse(FINDINGS, view(), CTX, { tab: 'results', column: rowField('sku') });
    // S2 is on 'a', 'b' and 'e'; S1 only on 'a'; 'd' is Fixed and so not open. Equal counts keep value order.
    expect(res.values[0]).toEqual({ value: 'S2', count: 3 });
    expect(res.values.slice(1, 3)).toEqual([{ value: 'bulk-00', count: 1 }, { value: 'bulk-01', count: 1 }]);
    expect(res.values).toContainEqual({ value: 'S1', count: 1 });
    expect(res.values).not.toContainEqual(expect.objectContaining({ value: 'S9' }));
    expect(res.total).toBe(27);
    expect(res.values).toHaveLength(27);
  });

  it('counts a column without its own filter, so picking a value never hides the others', () => {
    const res = buildColumnValuesResponse(FINDINGS, view({ filters: [{ field: rowField('sku'), values: ['S1'] }] }), CTX, { tab: 'results', column: rowField('sku') });
    expect(res.values[0]).toEqual({ value: 'S2', count: 3 });
    expect(res.values).toContainEqual({ value: 'S1', count: 1 });
  });

  it('is cut to the top 100, and searches case-insensitively', () => {
    const wide = [finding({ fingerprint: 'w', ruleId: 'r1' }, Array.from({ length: 150 }, (_, i) => ({ sku: `v-${String(i).padStart(3, '0')}` })))];
    const all = buildColumnValuesResponse(wide, view(), CTX, { tab: 'results', column: rowField('sku') });
    expect([all.values.length, all.total]).toEqual([100, 150]);
    const found = buildColumnValuesResponse(FINDINGS, view(), CTX, { tab: 'results', column: rowField('sku'), q: 'BULK-0' });
    expect(found.values.map(v => v.value)).toEqual(Array.from({ length: 10 }, (_, i) => `bulk-0${i}`));
    expect(found.total).toBe(10);
  });

  it('is empty for a column no finding has', () => {
    const res = buildColumnValuesResponse(FINDINGS, view(), CTX, { tab: 'results', column: rowField('nobody.has.this') });
    expect(res).toEqual({ column: 'row.nobody.has.this', values: [], total: 0 });
  });
});
