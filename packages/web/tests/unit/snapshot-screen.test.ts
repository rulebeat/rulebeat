/**
 * ADR 0008: what the snapshot screen decides to draw and where it points, as functions of what the
 * session holds. The requests are the address plus the scan id (one pair of functions writes both), a
 * finding that still exists links to its live finding on its own tab, and a failed read is never drawn
 * as a run with no findings.
 */
import { describe, expect, it } from 'vitest';
import { viewFromSearchParams, filterValues } from '@/lib/finding-view';
import { emptySnapshotQuery, snapshotQueryToParams, type SnapshotQuery } from '@/lib/snapshot-query';
import type { SnapshotItem, SnapshotResponse } from '@/lib/snapshot-response';
import {
  LIVE_FINDING_NOTE, clearedSnapshotQuery, liveFindingHref, searchedSnapshotQuery, snapshotExportUrl, snapshotFacetOptions,
  snapshotScreenOf, snapshotUrl, toggledSnapshotQuery, type SnapshotScreenInput,
} from '@/lib/snapshot-screen';

const item = (over: Partial<SnapshotItem> = {}): SnapshotItem => ({
  fingerprint: 'fp-1', ruleId: 'rule-1', severity: 'high', title: 'Example', kind: 'state',
  resourceId: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-one',
  resourceName: 'vm-one', resourceType: 'Microsoft.Compute/virtualMachines', resourceGroup: 'rg',
  subscriptionId: 's', rowCount: 1, exists: true, tab: 'results', ...over,
});

const response = (over: Partial<SnapshotResponse> = {}): SnapshotResponse => ({
  scan: { id: 'run-1', category: 'compute', startedAt: '2026-01-01T00:00:00.000Z' },
  total: 1, page: 1, pageCount: 1, pageSize: 50, items: [item()], facets: { severity: [], rule: [] }, ...over,
});

const query = (over: Partial<SnapshotQuery> = {}): SnapshotQuery => ({ ...emptySnapshotQuery(), ...over });

describe('the requests of the snapshot screen', () => {
  it('are the scan id and exactly the query the address carries', () => {
    const q = query({ severity: ['high'], rule: ['rule-1'], search: 'vm one', page: 3 });
    expect(snapshotUrl('run-1', q)).toBe(`/api/scans/run-1/snapshot?${snapshotQueryToParams(q)}`);
  });

  it('read an unfiltered first page with no query string at all', () => {
    expect(snapshotUrl('run-1', emptySnapshotQuery())).toBe('/api/scans/run-1/snapshot');
  });

  it('escape a scan id that is not a path segment', () => {
    expect(snapshotUrl('a/b', emptySnapshotQuery())).toBe('/api/scans/a%2Fb/snapshot');
  });

  it('ask for a file with the filters and without the page', () => {
    const q = query({ severity: ['high'], search: 'vm', page: 4 });
    const url = snapshotExportUrl('run-1', q, 'csv');
    expect(url.startsWith('/api/scans/run-1/snapshot/export?')).toBe(true);
    const params = new URL(url, 'http://localhost').searchParams;
    expect(params.get('format')).toBe('csv');
    expect(params.get('snapSeverity')).toBe('high');
    expect(params.get('snapQ')).toBe('vm');
    expect(params.has('snapPage')).toBe(false);
  });
});

describe('the link from a snapshot finding to its live finding', () => {
  const hrefParams = (href: string | null) => new URL(href!, 'http://localhost');

  it('is none for a finding that no longer exists', () => {
    expect(liveFindingHref(item({ exists: false }))).toBeNull();
  });

  it('opens the finding\'s own tab, whatever its status, narrowed to its rule and resource', () => {
    const url = hrefParams(liveFindingHref(item({ tab: 'advisories', kind: 'advisory' })));
    expect(url.pathname).toBe('/scans');
    expect(url.searchParams.get('tab')).toBe('advisories');
    const view = viewFromSearchParams(url.searchParams);
    expect(filterValues(view.filters, 'rule')).toEqual(['rule-1']);
    expect(filterValues(view.filters, 'status')).toEqual(['all']);
    expect(view.search).toBe('/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-one');
  });

  it('reaches a finding fixed long ago: the window is wide', () => {
    const view = viewFromSearchParams(hrefParams(liveFindingHref(item())).searchParams);
    expect(view.window.mode).toBe('relative');
    expect(view.window.mode === 'relative' && view.window.days).toBeGreaterThanOrEqual(3650);
  });

  it('searches the resource name when the record has no resource id, and nothing when it has neither', () => {
    expect(viewFromSearchParams(hrefParams(liveFindingHref(item({ resourceId: null }))).searchParams).search).toBe('vm-one');
    expect(viewFromSearchParams(hrefParams(liveFindingHref(item({ resourceId: null, resourceName: null }))).searchParams).search).toBe('');
  });
});

describe('which screen the snapshot shows', () => {
  const input = (over: Partial<SnapshotScreenInput>): SnapshotScreenInput => ({
    state: { status: 'ready', data: response(), query: '' },
    query: emptySnapshotQuery(),
    ...over,
  });

  it('lists the findings of the run', () => {
    expect(snapshotScreenOf(input({}))).toBe('rows');
  });

  it('says a run that truly had no findings had none', () => {
    expect(snapshotScreenOf(input({ state: { status: 'ready', data: response({ total: 0, items: [], pageCount: 1 }), query: '' } }))).toBe('empty-run');
  });

  it('says filters that match nothing are not an empty run', () => {
    const state = { status: 'ready' as const, data: response({ total: 0, items: [] }), query: '' };
    expect(snapshotScreenOf(input({ state, query: query({ severity: ['low'] }) }))).toBe('no-match');
    expect(snapshotScreenOf(input({ state, query: query({ search: 'zzz' }) }))).toBe('no-match');
    expect(snapshotScreenOf(input({ state, query: query({ rule: ['rule-9'] }) }))).toBe('no-match');
  });

  it('says a run that is gone, and a run whose records were not stored, each in its own words', () => {
    expect(snapshotScreenOf(input({ state: { status: 'not-found', message: 'gone', query: '' } }))).toBe('not-found');
    expect(snapshotScreenOf(input({ state: { status: 'no-records', message: 'not stored', query: '' } }))).toBe('no-records');
  });

  it('puts a failed read before an empty list, so a failure is never drawn as no findings', () => {
    const stale = response({ total: 0, items: [] });
    expect(snapshotScreenOf(input({ state: { status: 'failed', message: 'Could not load', stale, query: '' } }))).toBe('unavailable');
    expect(snapshotScreenOf(input({ state: { status: 'failed', message: 'Could not load', query: '' } }))).toBe('unavailable');
  });

  it('is loading until the first answer, and keeps the last list while the next is on its way', () => {
    expect(snapshotScreenOf(input({ state: { status: 'loading', query: null } }))).toBe('loading');
    expect(snapshotScreenOf(input({ state: { status: 'loading', stale: response(), query: '' } }))).toBe('rows');
  });
});

describe('the options of a filter dropdown', () => {
  it('are the facet\'s values with their counts, in the order sent', () => {
    const facet = [{ value: 'high', label: 'high', count: 4 }, { value: 'low', label: 'low', count: 1 }];
    expect(snapshotFacetOptions(facet, [], 'severity')).toEqual([
      { value: 'high', label: 'High', count: 4 }, { value: 'low', label: 'Low', count: 1 },
    ]);
  });

  it('keep a chosen value the other filters leave no match for, with a count of none', () => {
    const facet = [{ value: 'rule-1', label: 'Example', count: 2 }];
    expect(snapshotFacetOptions(facet, ['rule-9'], 'rule')).toEqual([
      { value: 'rule-1', label: 'Example', count: 2 }, { value: 'rule-9', label: 'rule-9', count: 0 },
    ]);
  });

  it('name a rule by its rule\'s name, not by its id', () => {
    expect(snapshotFacetOptions([{ value: 'rule-1', label: 'storage account is open', count: 2 }], [], 'rule')[0]!.label).toBe('storage account is open');
  });
});

describe('choosing a filter value', () => {
  it('adds a value that is not chosen and drops one that is, and goes back to the first page', () => {
    const q = query({ severity: ['high'], page: 4 });
    expect(toggledSnapshotQuery(q, 'severity', 'low')).toEqual(query({ severity: ['high', 'low'] }));
    expect(toggledSnapshotQuery(q, 'severity', 'high')).toEqual(query({}));
  });

  it('keeps severities in severity order, so two orders of one choice are one address', () => {
    const a = toggledSnapshotQuery(toggledSnapshotQuery(query(), 'severity', 'low'), 'severity', 'critical');
    expect(a.severity).toEqual(['critical', 'low']);
  });

  it('clears one filter, or sets the search, and goes back to the first page', () => {
    expect(clearedSnapshotQuery(query({ rule: ['rule-1'], severity: ['low'], page: 3 }), 'rule')).toEqual(query({ severity: ['low'] }));
    expect(searchedSnapshotQuery(query({ page: 3 }), 'vm')).toEqual(query({ search: 'vm' }));
  });
});

describe('the line on a snapshot', () => {
  it('says the rows and the status are on the live finding, in plain words', () => {
    expect(LIVE_FINDING_NOTE).toMatch(/rows/i);
    expect(LIVE_FINDING_NOTE).toMatch(/status/i);
    expect(LIVE_FINDING_NOTE).toMatch(/live finding/i);
    expect(LIVE_FINDING_NOTE).not.toContain('—');
  });
});
