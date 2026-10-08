/**
 * Issue #179, end to end: Problem, Advisory and Activity rules scan through runCategoryScan() with
 * the fake Azure context, then the Advisories widget route is asked what it lists. Only open
 * Advisories come back (never a Problem, Activity, fixed or suppressed finding), Overdue first and
 * then by Deadline, narrowed by the shared WidgetFilters shape, and the response says whether any
 * Advisory rule is enabled so an empty widget can say why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { rules as rulesTable } from '@/lib/db/tables';
import { getCategory } from '@/lib/db/categories';
import { createUser } from '@/lib/db/users';
import { runCategoryScan } from '@/lib/scan-runner';
import { listFindings, syncScanFindings } from '@/lib/db/findings';
import { computeActivityFingerprint } from '@rulebeat/core';
import { addSuppression } from '@/lib/suppressions';
import { updateRule } from '@/lib/rules';
import { mergeWidgetFilters, buildSummaryParams, type WidgetFilters } from '@/lib/dashboard-filters';
import type { AdvisoriesWidgetData } from '@/lib/advisories-widget';
import { resetDb, clearRules } from '../helpers/db';
import { argRow, fakeTenantContext, TEST_SUB_A, TEST_SUB_B } from '../helpers/fake-azure';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
const advisoriesRoute = await import('@/app/api/widgets/advisories/route');

const PROBLEM = 'aw-problem';
const ACTIVITY = 'aw-activity';
const SEC_ADV = 'aw-adv-security';
const REL_ADV = 'aw-adv-reliability';
const NOW = new Date('2026-06-15T12:00:00.000Z');

const secRows = (): Record<string, unknown>[] => [
  argRow({ name: 'a-past', retiresOn: '2026-06-01T00:00:00Z' }),
  argRow({ name: 'a-older', retiresOn: '2026-05-01T00:00:00Z' }),
  argRow({ name: 'a-future', retiresOn: '2026-12-31T00:00:00Z' }),
  argRow({ name: 'a-none' }),
  argRow({ name: 'a-gone', retiresOn: '2026-01-01T00:00:00Z' }),
  argRow({ name: 'a-supp', retiresOn: '2026-02-01T00:00:00Z' }),
  argRow({ name: 'a-subb', retiresOn: '2027-06-01T00:00:00Z', subscriptionId: TEST_SUB_B }),
];
const relRows = [argRow({ name: 'r-1', retiresOn: '2027-01-01T00:00:00Z' })];
let secResult: () => Record<string, unknown>[] = secRows;

async function insertRule(
  id: string, category: string, kind: 'state' | 'advisory', severity: string, tags?: string[],
): Promise<void> {
  await execRun(db.insert(rulesTable).values({
    id, name: id, description: 'test rule', category, severity, enabled: true,
    scope: JSON.stringify({ level: 'subscription' }), resourceTypes: JSON.stringify([]),
    conditions: JSON.stringify([]),
    rawKql: `resources | where type == "microsoft.compute/virtualmachines" // marker-${id}`,
    type: 'custom', kind, tags: tags ? JSON.stringify(tags) : undefined,
    deadlineField: kind === 'advisory' ? 'retiresOn' : null,
  }));
}

function ctx() {
  return fakeTenantContext({
    subscriptionIds: [TEST_SUB_A, TEST_SUB_B],
    rows: kql => {
      if (kql.includes(`marker-${SEC_ADV}`)) return secResult();
      if (kql.includes(`marker-${REL_ADV}`)) return relRows;
      return [argRow({ name: 'p-1' })];
    },
  });
}

/** A Logs rule's finding. Only the Logs engine writes one, so it is recorded the way a scan does. */
async function seedActivityFinding(): Promise<void> {
  await syncScanFindings({
    scanId: 'aw-activity-scan', category: 'security', ranRuleIds: [ACTIVITY], finishedAt: NOW.toISOString(),
    findings: [{
      module: 'security', ruleId: ACTIVITY, fingerprint: computeActivityFingerprint(ACTIVITY, 'sign-in'), kind: 'activity',
      dimensionKey: 'sign-in', severity: 'high', category: 'security', subscriptionId: TEST_SUB_A, title: 'sign-in risk',
      description: 'test', evidence: {}, recommendation: 'investigate', remediationSteps: [], detectedAt: NOW.toISOString(),
    }],
  });
}

async function scan(): Promise<void> {
  for (const id of ['security', 'reliability']) {
    await runCategoryScan((await getCategory(id))!, {
      ctx: ctx(),
      ruleIds: [PROBLEM, SEC_ADV, REL_ADV],
    });
  }
}

async function widget(query = ''): Promise<AdvisoriesWidgetData> {
  const res = await advisoriesRoute.GET(new Request(`http://localhost/api/widgets/advisories${query}`));
  expect(res.status).toBe(200);
  return res.json();
}
const names = (d: AdvisoriesWidgetData) => d.items.map(i => i.resourceName);

beforeEach(async () => {
  await resetDb();
  await clearRules();
  mockAuth.mockReset();
  secResult = secRows;
  const viewer = await createUser({ email: 'viewer@example.com', role: 'viewer' });
  if ('error' in viewer) throw new Error(viewer.error);
  mockAuth.mockResolvedValue({ user: { uid: viewer.user.id } });
  await insertRule(PROBLEM, 'security', 'state', 'high');
  await insertRule(SEC_ADV, 'security', 'advisory', 'high', ['retirement']);
  await insertRule(REL_ADV, 'reliability', 'advisory', 'low');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the Advisories widget route', () => {
  it('lists open Advisories only, Overdue first and then by Deadline with none last', async () => {
    await scan();
    secResult = () => secRows().filter(r => r.name !== 'a-gone');
    await scan();
    await seedActivityFinding();
    const found = await listFindings();
    expect(found.some(f => f.kind === 'state')).toBe(true);
    expect(found.some(f => f.kind === 'activity')).toBe(true);
    expect(found.find(f => f.resourceName === 'a-gone')?.status).toBe('fixed');
    const supp = found.find(f => f.resourceName === 'a-supp')!;
    await addSuppression({
      id: 'aw-sup', fingerprint: supp.fingerprint, resourceId: supp.resourceId,
      reason: 'accepted', suppressedAt: NOW.toISOString(),
    });

    const data = await widget();
    expect(names(data)).toEqual(['a-older', 'a-past', 'a-future', 'r-1', 'a-subb', 'a-none']);
    expect(data.total).toBe(6);
  });

  it('carries rule, resource, severity, Deadline and Overdue on each row', async () => {
    await scan();
    const data = await widget('?categories=reliability');
    expect(data.items).toEqual([expect.objectContaining({
      ruleId: REL_ADV, ruleName: REL_ADV, resourceName: 'r-1', severity: 'low',
      category: 'reliability', deadline: '2027-01-01T00:00:00.000Z', overdue: false,
    })]);
    const overdue = (await widget('?categories=security')).items.filter(i => i.overdue).map(i => i.resourceName);
    expect(overdue).toEqual(['a-gone', 'a-supp', 'a-older', 'a-past']);
  });

  it('shows suppressed Advisories only when the filter asks for them', async () => {
    await scan();
    const supp = (await listFindings()).find(f => f.resourceName === 'a-supp')!;
    await addSuppression({
      id: 'aw-sup', fingerprint: supp.fingerprint, resourceId: supp.resourceId,
      reason: 'accepted', suppressedAt: NOW.toISOString(),
    });
    expect(names(await widget())).not.toContain('a-supp');
    expect(names(await widget('?suppressed=1'))).toContain('a-supp');
  });

  it('caps the rows at the limit and still returns the full total', async () => {
    await scan();
    const all = await widget();
    const capped = await widget('?limit=2');
    expect(capped.items).toHaveLength(2);
    expect(names(capped)).toEqual(names(all).slice(0, 2));
    expect(capped.total).toBe(all.total);
  });

  it('narrows by category, severity, rule, subscription, resource group and rule tag', async () => {
    await scan();
    expect(names(await widget('?categories=reliability'))).toEqual(['r-1']);
    expect(new Set((await widget('?severities=low')).items.map(i => i.ruleId))).toEqual(new Set([REL_ADV]));
    expect(new Set((await widget(`?ruleIds=${SEC_ADV}`)).items.map(i => i.ruleId))).toEqual(new Set([SEC_ADV]));
    expect(names(await widget(`?subscriptions=${TEST_SUB_B}`))).toEqual(['a-subb']);
    expect(names(await widget('?resourceGroups=rg-nowhere'))).toEqual([]);
    expect(new Set((await widget('?tags=retirement')).items.map(i => i.ruleId))).toEqual(new Set([SEC_ADV]));
  });

  it('lets a per-widget value replace the dashboard filter instead of intersecting it', async () => {
    await scan();
    const dashboard: WidgetFilters = { categories: ['security'], dateWindow: { mode: 'relative', days: 7 } };
    const merged = mergeWidgetFilters(dashboard, { category: 'reliability' });
    expect(names(await widget(`?${buildSummaryParams(merged)}`))).toEqual(['r-1']);
    expect(names(await widget(`?${buildSummaryParams(dashboard)}`))).not.toContain('r-1');
  });
});

describe('who may read the Advisories widget', () => {
  it('refuses a request with no signed-in user', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await advisoriesRoute.GET(new Request('http://localhost/api/widgets/advisories'));
    expect(res.status).toBe(401);
  });

  it('serves a viewer, the lowest role', async () => {
    const res = await advisoriesRoute.GET(new Request('http://localhost/api/widgets/advisories'));
    expect(res.status).toBe(200);
  });
});

describe('the Advisory rules signal', () => {
  it('says no Advisory rule is enabled when none is, without calling the empty list clean', async () => {
    await scan();
    await updateRule(SEC_ADV, { enabled: false });
    await updateRule(REL_ADV, { enabled: false });
    const data = await widget();
    expect(data.hasAdvisoryRules).toBe(false);
  });

  it('says Advisory rules exist when one is enabled and nothing is open', async () => {
    secResult = () => [];
    await scan();
    const data = await widget('?categories=security');
    expect(data.items).toEqual([]);
    expect(data.total).toBe(0);
    expect(data.hasAdvisoryRules).toBe(true);
  });

  it('looks only at the filter\'s categories, so a category without an Advisory rule says so', async () => {
    await updateRule(REL_ADV, { enabled: false });
    expect((await widget('?categories=reliability')).hasAdvisoryRules).toBe(false);
    expect((await widget('?categories=security')).hasAdvisoryRules).toBe(true);
    expect((await widget()).hasAdvisoryRules).toBe(true);
  });

  it('does not count a Problem rule as an Advisory rule', async () => {
    await updateRule(SEC_ADV, { enabled: false });
    await updateRule(REL_ADV, { enabled: false });
    expect((await widget('?categories=security')).hasAdvisoryRules).toBe(false);
  });
});
