/**
 * #406: the Top resources and Recent findings rows open Scans on the exact resource id, not on a text
 * search for its name (`q=vm1` also found `vm10`, so a row opened more findings than it counted). The real
 * widgets are rendered over the rows their real routes return, each row is clicked, and the address the
 * widget pushes is read back the way /scans reads it: the list it opens is held to the row's own count,
 * for Everything and for a viewer below it. Recharts and the table row are stubbed only to hand the
 * widget's own click handlers to the test, since nothing here runs in a browser.
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';
import { buildAccess, parseScope, type Access } from '@/lib/access-model';
import { viewFromSearchParams } from '@/lib/finding-view';
import { queryView } from '@/lib/db/finding-views';
import { parseViewTab } from '@/lib/view-response';
import type { WidgetFilters } from '@/lib/dashboard-filters';
import { EVERYTHING_ACCESS } from '../helpers/access';

const hoisted = vi.hoisted(() => ({
  pushed: [] as string[],
  clicks: [] as (() => void)[],
  data: null as unknown,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: (href: string) => { hoisted.pushed.push(href); } }) }));
vi.mock('@/lib/hooks/use-widget-fetch', () => ({
  useWidgetFetch: () => ({ data: hoisted.data, loading: false, failed: false, retry: () => undefined }),
}));
vi.mock('recharts', () => {
  const passthrough = ({ children }: { children?: ReactNode }) => children ?? null;
  const nothing = () => null;
  return {
    ResponsiveContainer: passthrough, BarChart: passthrough, Bar: passthrough, XAxis: nothing, YAxis: nothing, Tooltip: nothing,
    Cell: ({ onClick }: { onClick?: () => void }) => { if (onClick) hoisted.clicks.push(onClick); return null; },
  };
});
vi.mock('@/components/ui/table', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/components/ui/table')>();
  return {
    ...original,
    TableRow: ({ onClick, children }: { onClick?: () => void; children?: ReactNode }) => {
      if (onClick) hoisted.clicks.push(onClick);
      return children ?? null;
    },
  };
});
const { TopResourcesWidget } = await import('@/components/dashboard/widgets/top-resources-widget');
const { RecentFindingsWidget } = await import('@/components/dashboard/widgets/recent-findings-widget');

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

/** Renders `widget` over `rows` and clicks each of its rows in turn: the address each one pushes. */
function clickedHrefs(widget: typeof TopResourcesWidget | typeof RecentFindingsWidget, rows: unknown[]): string[] {
  hoisted.data = rows;
  hoisted.clicks.length = 0;
  hoisted.pushed.length = 0;
  renderToStaticMarkup(createElement(widget, { config: {}, filters: FILTERS, refreshKey: 0 }));
  const clicks = [...hoisted.clicks];
  expect(clicks, 'the widget rendered a clickable row for each row it was given').toHaveLength(rows.length);
  return clicks.map(click => {
    hoisted.pushed.length = 0;
    click();
    expect(hoisted.pushed).toHaveLength(1);
    return hoisted.pushed[0]!;
  });
}

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
    const hrefs = clickedHrefs(TopResourcesWidget, rows);
    for (const [i, row] of rows.entries()) {
      const list = await opened(hrefs[i]!, access);
      expect(list.total, row.resourceName).toBe(row.count);
      expect(new Set(list.items.map(i => i.finding.resourceId?.toLowerCase()))).toEqual(new Set([row.resourceId.toLowerCase()]));
    }
  });

  it('a Recent findings row opens the one finding it shows', async () => {
    const rows = await (await recentFindings.GET(new Request('http://localhost/api/widgets/findings'))).json() as
      { fingerprint: string; ruleId: string; resourceId: string; resourceName: string }[];
    expect(rows.length).toBeGreaterThan(0);
    const hrefs = clickedHrefs(RecentFindingsWidget, rows);
    for (const [i, row] of rows.entries()) {
      const list = await opened(hrefs[i]!, access);
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

  it('links by id and no longer by a text search for the name', async () => {
    const rows = await (await topResources.GET(new Request('http://localhost/api/widgets/top-resources'))).json() as
      { resourceId: string }[];
    const recent = await (await recentFindings.GET(new Request('http://localhost/api/widgets/findings'))).json() as unknown[];
    const hrefs = [...clickedHrefs(TopResourcesWidget, rows), ...clickedHrefs(RecentFindingsWidget, recent)];
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      const params = new URL(href, 'http://localhost').searchParams;
      expect(params.getAll('f').some(f => f.startsWith('resourceId=/subscriptions/'))).toBe(true);
      expect(params.has('q')).toBe(false);
    }
  });
});
