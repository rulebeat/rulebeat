/**
 * #406: the Top resources and Recent findings rows open Scans on the exact resource id, not on a text
 * search for its name (`q=vm1` also found `vm10`, so a row opened more findings than it counted). Each row
 * of the real widget routes is followed through the link `buildScansHref()` makes for it, into the view
 * the Scans address reads back, and the list it opens is held to the row's own count, for Everything and
 * for a viewer below it.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';
import { buildAccess, parseScope, type Access } from '@/lib/access-model';
import { buildScansHref } from '@/lib/scans-link';
import { viewFromSearchParams } from '@/lib/finding-view';
import { queryView } from '@/lib/db/finding-views';
import { parseViewTab } from '@/lib/view-response';
import type { WidgetFilters } from '@/lib/dashboard-filters';
import { EVERYTHING_ACCESS } from '../helpers/access';

const mockRequireRole = vi.fn();
vi.mock('@/lib/api-auth', () => ({ requireRole: (...args: unknown[]) => mockRequireRole(...args) }));
const topResources = await import('@/app/api/widgets/top-resources/route');
const recentFindings = await import('@/app/api/widgets/findings/route');

const SUB_ONE = '00000000-0000-0000-0000-00000000000a';
const SUB_TWO = '00000000-0000-0000-0000-00000000000b';
const FILTERS: WidgetFilters = { dateWindow: { mode: 'relative', days: 7 } };

beforeAll(async () => {
  await resetDb();
  await storeScan([
    // vm1 carries three findings; vm10, whose name starts with it, one; VM1 is the same resource written
    // in another case by another rule.
    syntheticFinding('vm1', [{ n: 1 }], { ruleId: 'link-rule-a', subscriptionId: SUB_ONE }),
    syntheticFinding('vm1', [{ n: 2 }], { ruleId: 'link-rule-b', subscriptionId: SUB_ONE }),
    syntheticFinding('VM1', [{ n: 3 }], { ruleId: 'link-rule-c', subscriptionId: SUB_ONE }),
    syntheticFinding('vm10', [{ n: 4 }], { ruleId: 'link-rule-a', subscriptionId: SUB_ONE }),
    syntheticFinding('vm1', [{ n: 5 }], { ruleId: 'link-rule-a', subscriptionId: SUB_TWO }),
    syntheticFinding('web', [{ n: 6 }], { ruleId: 'link-rule-a', subscriptionId: SUB_TWO }),
  ], { scanId: 'link-scan', finishedAt: new Date().toISOString() });
});

const viewerOn = (sub: string): Access =>
  buildAccess([{ tenantId: 't', scope: parseScope(`/subscriptions/${sub}`)!, role: 'viewer' }], 'manual');

/** The list a link opens: the href read back the way /scans reads it, answered under `access`. */
async function opened(href: string, access: Access) {
  const params = new URL(href, 'http://localhost').searchParams;
  const tab = parseViewTab(params.get('tab')) ?? 'results';
  return queryView(viewFromSearchParams(params), { tab, showSuppressed: false }, access);
}

describe.each([
  ['Everything', EVERYTHING_ACCESS],
  ['a viewer on one subscription', viewerOn(SUB_TWO)],
])('for %s', (_name, access) => {
  beforeEach(() => { mockRequireRole.mockResolvedValue({ access }); });

  it('a Top resources row opens exactly the findings it counts', async () => {
    const rows = await (await topResources.GET(new Request('http://localhost/api/widgets/top-resources'))).json() as
      { resourceId: string; resourceName: string; count: number }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const list = await opened(buildScansHref(FILTERS, { resourceId: row.resourceId }), access);
      expect(list.total, row.resourceName).toBe(row.count);
      expect(new Set(list.items.map(i => i.finding.resourceId?.toLowerCase()))).toEqual(new Set([row.resourceId.toLowerCase()]));
    }
  });

  it('a Recent findings row opens the one finding it shows', async () => {
    const rows = await (await recentFindings.GET(new Request('http://localhost/api/widgets/findings'))).json() as
      { fingerprint: string; ruleId: string; resourceId: string; resourceName: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const list = await opened(buildScansHref(FILTERS, { ruleId: row.ruleId, resourceId: row.resourceId }), access);
      expect(list.total, `${row.ruleId} on ${row.resourceName}`).toBe(1);
      expect(list.items[0]!.finding.fingerprint).toBe(row.fingerprint);
    }
  });
});

describe('Everything', () => {
  beforeEach(() => { mockRequireRole.mockResolvedValue({ access: EVERYTHING_ACCESS }); });

  it('counts a resource once, whatever case its rules wrote its id in', async () => {
    const rows = await (await topResources.GET(new Request('http://localhost/api/widgets/top-resources'))).json() as
      { resourceId: string; resourceName: string; count: number }[];
    const vm1 = rows.filter(r => r.resourceId.toLowerCase().includes(`/subscriptions/${SUB_ONE}/`) && /vm1$/i.test(r.resourceId));
    expect(vm1.map(r => r.count)).toEqual([3]);
  });

  it('links by id and no longer by a text search for the name', () => {
    const href = buildScansHref(FILTERS, { resourceId: '/subscriptions/s/resourceGroups/rg/providers/p/vm1' });
    const params = new URL(href, 'http://localhost').searchParams;
    expect(params.get('f')).toBe('resourceId=/subscriptions/s/resourceGroups/rg/providers/p/vm1');
    expect(params.has('q')).toBe(false);
  });
});
