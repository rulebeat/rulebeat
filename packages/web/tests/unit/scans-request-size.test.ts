/**
 * #388: a Scope list too long for an address travels as `scopeset=<hash>` (ADR 0016), and every request the
 * Scans page makes for a view carries the hash, never the list, so none can pass the smallest request line a
 * supported host allows (8 KB). The requests are built by the same functions the explorer fetches with, from
 * fixtures at the worst case a person can build: the most paths one set holds, each a long resource group path.
 */
import { describe, expect, it } from 'vitest';
import {
  columnValuesUrl, explorerAddress, exportUrl, groupUrl, rowsUrl, ruleFindingsUrl, viewUrl, type ViewRequest,
} from '@/lib/explorer-session';
import { emptyView, encodeView, viewFromSearchParams, type View } from '@/lib/finding-view';
import { commitScopePicks } from '@/lib/scope-picks-write';
import { SCOPE_SET_MAX_PATHS } from '@/lib/scope-sets';

const SUBSCRIPTION = '00000000-0000-0000-0000-00000000000a';
const MAX_REQUEST_LINE = 8 * 1024;
const HASH = 'c'.repeat(64);

const worstCasePicks = Array.from({ length: SCOPE_SET_MAX_PATHS }, (_, i) => `/subscriptions/${SUBSCRIPTION}/resourceGroups/a-long-resource-group-name-number-${i}`);

/** A view that uses every param the explorer can write at once, with a long search and many filter values. */
function busyView(extra: Partial<View>): View {
  return {
    ...emptyView(),
    filters: [
      { field: 'category', values: ['security', 'cost', 'identity', 'reliability', 'compliance'] },
      { field: 'severity', values: ['critical', 'high', 'medium'] },
      { field: 'tags', values: Array.from({ length: 10 }, (_, i) => `framework:tag-number-${i}`) },
      { field: 'row.zone', values: ['a', 'b', 'c'] },
    ],
    search: 'a search for something'.repeat(5),
    source: ['rulebeat-core', 'aprl-v2', 'community', 'custom'],
    age: { min: 31, max: 90 },
    columns: ['zone', 'properties.sku', 'properties.tier'],
    groupBy: ['category', 'severity'],
    ...extra,
  };
}

const requestsFor = (view: View): Record<string, string> => {
  const request: ViewRequest = { view, tab: 'results', showSuppressed: true };
  return {
    view: viewUrl(request),
    rows: rowsUrl(request, 'f'.repeat(64), 3, [{ path: 'zone', value: 'a' }]),
    group: groupUrl(request, ['security', 'high'], 2),
    columnValues: columnValuesUrl(request, 'row.zone', 'a'),
    export: exportUrl(request, 'csv'),
    ruleFindings: ruleFindingsUrl(request, 'a-rule-id', 2),
    address: `/scans?${explorerAddress(view, { extraParams: { tab: 'results' }, viewId: '1'.repeat(36) })}`,
  };
};

describe('a list over the budget is sent to the server, and only its hash travels', () => {
  it('commitScopePicks keeps the hash and not the list for the largest set', async () => {
    const created: string[][] = [];
    const written = await commitScopePicks(worstCasePicks, async paths => { created.push(paths); return { ok: true, hash: HASH }; });
    expect(written).toEqual({ ok: true, scope: undefined, scopeSet: HASH });
    expect(created).toEqual([worstCasePicks]);
  });

  it('every request the Scans page builds for such a view stays under 8 KB and names no path', () => {
    const requests = requestsFor(busyView({ scopeSet: HASH }));
    for (const [name, url] of Object.entries(requests)) {
      expect(new TextEncoder().encode(url).length, name).toBeLessThan(MAX_REQUEST_LINE);
      expect(url, name).toContain(`scopeset=${HASH}`);
      expect(url, name).not.toContain('resourceGroups');
      expect(url, name).not.toContain('scope=');
    }
  });

  it('the same fixtures would pass 8 KB if the list travelled in the address', () => {
    const inline = worstCasePicks.join(',');
    expect(new TextEncoder().encode(inline).length).toBeGreaterThan(MAX_REQUEST_LINE);
    expect(encodeView(busyView({ scope: worstCasePicks })).needsScopeSet).toBe(true);
  });

  it('a list that fits stays inline and still fits the request line with every other param written', () => {
    const picks = worstCasePicks.slice(0, 10);
    for (const [name, url] of Object.entries(requestsFor(busyView({ scope: picks })))) {
      expect(new TextEncoder().encode(url).length, name).toBeLessThan(MAX_REQUEST_LINE);
      expect(url, name).toContain('scope=');
    }
  });
});

describe('the page reads the hash and never an expanded list', () => {
  it('an address with scopeset= is a View with the hash and no Scope list', () => {
    const view = viewFromSearchParams(new URLSearchParams(`tab=results&scopeset=${HASH.toUpperCase()}&scope=${encodeURIComponent(worstCasePicks[0]!)}`));
    expect(view.scopeSet).toBe(HASH);
    expect(view.scope).toBeUndefined();
  });

  it('writes the address back with the hash', () => {
    const query = explorerAddress(viewFromSearchParams(new URLSearchParams(`scopeset=${HASH}`)));
    expect(query).toBe(`scopeset=${HASH}`);
  });
});
