/**
 * The Advisories widget and the dashboard filter lists answer from the same server read as the
 * explorer (lib/db/finding-views.ts). Their JSON shapes are pinned with known literals over a real
 * scan, and their numbers are compared with what /api/findings/view says for the same filters, so the
 * dashboard and the Scans page cannot drift apart.
 */
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { rules as rulesTable } from '@/lib/db/tables';
import { getCategory } from '@/lib/db/categories';
import { createUser } from '@/lib/db/users';
import { runCategoryScan } from '@/lib/scan-runner';
import { addSuppression } from '@/lib/suppressions';
import { listFindings } from '@/lib/db/findings';
import { queryFilterOptions } from '@/lib/db/finding-views';
import type { AdvisoriesWidgetData } from '@/lib/advisories-widget';
import type { ViewResponse } from '@/lib/view-response';
import { clearRules, resetDb } from '../helpers/db';
import { argRow, fakeTenantContext, TEST_SUB_A, TEST_SUB_B } from '../helpers/fake-azure';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
const filterOptions = await import('@/app/api/widgets/filter-options/route');
const advisoriesWidget = await import('@/app/api/widgets/advisories/route');
const viewRoute = await import('@/app/api/findings/view/route');

const PROBLEM = 'wv-problem';
const ADV_HIGH = 'wv-adv-high';
const ADV_LOW = 'wv-adv-low';
const NOW = new Date('2026-06-15T12:00:00.000Z');

let advRows: () => Record<string, unknown>[];

async function insertRule(id: string, kind: 'state' | 'advisory', severity: string, tags?: string[]): Promise<void> {
  await execRun(db.insert(rulesTable).values({
    id, name: `Rule ${id}`, description: 'test rule', category: 'security', severity, enabled: true,
    scope: JSON.stringify({ level: 'subscription' }), resourceTypes: JSON.stringify([]),
    conditions: JSON.stringify([]),
    rawKql: `resources | where type == "microsoft.compute/virtualmachines" // marker-${id}`,
    type: 'custom', kind, tags: tags ? JSON.stringify(tags) : undefined,
  }));
}

async function scan(): Promise<void> {
  const ctx = fakeTenantContext({
    subscriptionIds: [TEST_SUB_A, TEST_SUB_B],
    rows: kql => {
      if (kql.includes(`marker-${PROBLEM}`)) return [argRow({ name: 'p-1' })];
      if (kql.includes(`marker-${ADV_HIGH}`)) return advRows();
      return [argRow({ name: 'low-1', resourceGroup: 'rg-low' })];
    },
  });
  await runCategoryScan((await getCategory('security'))!, { ctx, ruleIds: [PROBLEM, ADV_HIGH, ADV_LOW] });
}

const widgetUrl = (query = '') => new Request(`http://localhost/api/widgets/advisories${query}`);
async function widget(query = ''): Promise<AdvisoriesWidgetData> {
  const res = await advisoriesWidget.GET(widgetUrl(query));
  expect(res.status).toBe(200);
  return res.json();
}
async function view(query: string): Promise<ViewResponse> {
  const res = await viewRoute.GET(new Request(`http://localhost/api/findings/view?${query}`));
  expect(res.status).toBe(200);
  return res.json();
}

beforeEach(async () => {
  await resetDb();
  await clearRules();
  mockAuth.mockReset();
  advRows = () => [
    argRow({ name: 'a-one' }),
    argRow({ name: 'a-two', subscriptionId: TEST_SUB_B, resourceGroup: 'rg-b' }),
    argRow({ name: 'a-three' }),
  ];
  const viewer = await createUser({ email: 'viewer@example.com', role: 'viewer' });
  if ('error' in viewer) throw new Error(viewer.error);
  mockAuth.mockResolvedValue({ user: { uid: viewer.user.id } });
  await insertRule(PROBLEM, 'state', 'high');
  await insertRule(ADV_HIGH, 'advisory', 'high', ['retirement']);
  await insertRule(ADV_LOW, 'advisory', 'low');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  await scan();
  vi.useRealTimers();
});

describe('the filter lists', () => {
  it('answer with the same five lists, over every finding of every kind and status', async () => {
    // a-two leaves the next scan, so it is fixed: its subscription and resource group stay listed.
    advRows = () => [argRow({ name: 'a-one' }), argRow({ name: 'a-three' })];
    await scan();
    expect((await listFindings()).find(f => f.resourceName === 'a-two')?.status).toBe('fixed');

    const res = await filterOptions.GET();
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['categories', 'resourceGroups', 'rules', 'subscriptions', 'tags']);
    expect(body.tags).toEqual(['retirement']);
    expect(body.subscriptions).toEqual([TEST_SUB_A, TEST_SUB_B]);
    expect(body.resourceGroups).toEqual(['rg-b', 'rg-low', 'rg-test']);
    expect(body.rules).toEqual([
      { id: ADV_HIGH, name: `Rule ${ADV_HIGH}` },
      { id: ADV_LOW, name: `Rule ${ADV_LOW}` },
      { id: PROBLEM, name: `Rule ${PROBLEM}` },
    ]);
    expect((body.categories as { id: string }[]).map(c => c.id)).toContain('security');
  });

  it('name a rule from the rules table, and fall back to the finding title once the rule is gone', async () => {
    const titles = new Map((await listFindings()).map(f => [f.ruleId, f.title ?? ''] as const));
    await execRun(db.update(rulesTable).set({ name: 'Renamed' }).where(eq(rulesTable.id, PROBLEM)));
    await execRun(db.delete(rulesTable).where(eq(rulesTable.id, ADV_LOW)));
    const { rules } = await queryFilterOptions();
    expect(rules).toEqual([
      { id: ADV_HIGH, name: `Rule ${ADV_HIGH}` },
      { id: PROBLEM, name: 'Renamed' },
      { id: ADV_LOW, name: titles.get(ADV_LOW) ?? '' },
    ].sort((a, b) => a.name.localeCompare(b.name)));
    expect(titles.get(ADV_LOW)).toBeTruthy();
  });

  it('list the same subscriptions and resource groups the view route facets list when nothing is filtered', async () => {
    const options = await queryFilterOptions();
    const results = await view('tab=results&status=all');
    const advisories = await view('tab=advisories&status=all');
    const facetValues = (r: ViewResponse, dim: 'subscription' | 'resourceGroup') => r.facets[dim].map(o => o.value);
    expect(options.subscriptions).toEqual([TEST_SUB_A, TEST_SUB_B]);
    expect(options.resourceGroups).toEqual(['rg-b', 'rg-low', 'rg-test']);
    // Every value either tab's facets list is on offer, and every offer is in one of them.
    for (const [dim, offered] of [['subscription', options.subscriptions], ['resourceGroup', options.resourceGroups]] as const) {
      const faceted = [...facetValues(results, dim), ...facetValues(advisories, dim)];
      for (const value of faceted) expect(offered).toContain(value);
      for (const value of offered) expect(faceted).toContain(value);
    }
  });
});

describe('the Advisories widget', () => {
  it('keeps its shape: items with eight keys, a total and the Advisory rules signal', async () => {
    const data = await widget('?severities=low');
    expect(data).toEqual({
      items: [{
        fingerprint: expect.any(String), ruleId: ADV_LOW, ruleName: `Rule ${ADV_LOW}`,
        resourceId: expect.stringContaining('/virtualMachines/low-1'), resourceName: 'low-1',
        category: 'security', severity: 'low', lastSeenAt: NOW.toISOString(),
      }],
      total: 1,
      hasAdvisoryRules: true,
    });
    expect(Object.keys(data.items[0]).sort()).toEqual([
      'category', 'fingerprint', 'lastSeenAt', 'resourceId', 'resourceName', 'ruleId', 'ruleName', 'severity',
    ]);
  });

  it('lists the same open Advisories, and counts the same total, as the view route for the same filters', async () => {
    const found = (await listFindings()).find(f => f.resourceName === 'a-three')!;
    await addSuppression({
      id: 'wv-sup', fingerprint: found.fingerprint, resourceId: found.resourceId, reason: 'accepted', suppressedAt: NOW.toISOString(),
    });
    const cases: [string, string][] = [
      ['', 'tab=advisories'],
      ['?severities=high', 'tab=advisories&severity=high'],
      ['?categories=reliability','tab=advisories&category=reliability'],
      [`?subscriptions=${TEST_SUB_B}`, `tab=advisories&subscription=${TEST_SUB_B}`],
      ['?resourceGroups=rg-low', 'tab=advisories&rg=rg-low'],
      ['?tags=retirement', 'tab=advisories&tags=retirement'],
      [`?ruleIds=${ADV_LOW}`, `tab=advisories&ruleId=${ADV_LOW}`],
      ['?suppressed=1', 'tab=advisories&suppressed=1'],
    ];
    for (const [widgetQuery, viewQuery] of cases) {
      const data = await widget(widgetQuery ? `${widgetQuery}&limit=50` : '?limit=50');
      const response = await view(viewQuery);
      expect(data.total, widgetQuery).toBe(response.total);
      expect(data.items.map(i => i.fingerprint).sort(), widgetQuery)
        .toEqual(response.items.map(i => i.finding.fingerprint).sort());
    }
  });

  it('agrees with the Advisories tiles on how many are open', async () => {
    const response = await view('tab=advisories');
    expect((await widget('?limit=50')).total).toBe(response.tiles.total);
    expect(response.tiles.total).toBe(4);
  });

  it('orders by severity, then most recently seen, and keeps the full total behind a limit', async () => {
    const data = await widget('?limit=2');
    expect(data.items.map(i => i.severity)).toEqual(['high', 'high']);
    expect(data.total).toBe(4);
  });
});
