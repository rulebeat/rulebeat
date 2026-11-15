/**
 * The Top Violating Rules widget route: open Problem findings per rule, each rule shown at the
 * highest severity among its counted findings (not the severity of whichever finding was read
 * first), most findings first.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeFingerprint } from '@rulebeat/core';
import { createUser } from '@/lib/db/users';
import { syncScanFindings } from '@/lib/db/findings';
import { saveRules } from '@/lib/rules';
import type { Rule } from '@rulebeat/core';
import type { Finding, Severity } from '@/lib/types';
import { clearRules, resetDb } from '../helpers/db';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
const topRulesRoute = await import('@/app/api/widgets/top-rules/route');

const MIXED = 'tr-mixed';
const BUSY = 'tr-busy';
const CATEGORY = 'security';

const testRule = (id: string): Rule => ({
  id, name: `rule ${id}`, description: 'test', category: CATEGORY, severity: 'medium', enabled: true,
  type: 'custom', scope: { level: 'subscription' }, resourceTypes: [], conditions: [],
});

function finding(ruleId: string, name: string, severity: Severity): Finding {
  const resourceId = `/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Compute/virtualMachines/${name}`;
  return {
    module: CATEGORY, ruleId, fingerprint: computeFingerprint(ruleId, resourceId), severity, category: CATEGORY,
    resourceId, resourceType: 'microsoft.compute/virtualmachines', resourceName: name, subscriptionId: 'sub-1',
    resourceGroup: 'rg-1', title: 'test finding', description: 'test', evidence: {}, recommendation: 'fix it',
    remediationSteps: [], detectedAt: new Date().toISOString(),
  };
}

async function topRules(query = ''): Promise<Array<{ ruleId: string; count: number; severity: Severity }>> {
  const res = await topRulesRoute.GET(new Request(`http://localhost/api/widgets/top-rules${query}`));
  expect(res.status).toBe(200);
  return res.json();
}

beforeEach(async () => {
  await resetDb();
  await clearRules();
  mockAuth.mockReset();
  const viewer = await createUser({ email: 'viewer@example.com', role: 'viewer' });
  if ('error' in viewer) throw new Error(viewer.error);
  mockAuth.mockResolvedValue({ user: { uid: viewer.user.id } });
  await saveRules([testRule(MIXED), testRule(BUSY)]);
});

describe('the Top Violating Rules route', () => {
  it('shows the highest severity among a rule\'s findings, whichever was read first', async () => {
    await syncScanFindings({
      scanId: 's1', category: CATEGORY, ranRuleIds: [MIXED], finishedAt: new Date().toISOString(),
      findings: [finding(MIXED, 'vm-a', 'low'), finding(MIXED, 'vm-b', 'critical'), finding(MIXED, 'vm-c', 'medium')],
    });

    const data = await topRules();
    expect(data).toEqual([expect.objectContaining({ ruleId: MIXED, count: 3, severity: 'critical' })]);
  });

  it('shows the highest severity of the findings a Severity filter keeps', async () => {
    await syncScanFindings({
      scanId: 's1', category: CATEGORY, ranRuleIds: [MIXED], finishedAt: new Date().toISOString(),
      findings: [finding(MIXED, 'vm-a', 'low'), finding(MIXED, 'vm-b', 'critical'), finding(MIXED, 'vm-c', 'medium')],
    });

    const data = await topRules('?severities=low,medium');
    expect(data).toEqual([expect.objectContaining({ ruleId: MIXED, count: 2, severity: 'medium' })]);
  });

  it('still orders rules by how many findings they hold', async () => {
    await syncScanFindings({
      scanId: 's1', category: CATEGORY, ranRuleIds: [MIXED, BUSY], finishedAt: new Date().toISOString(),
      findings: [
        finding(MIXED, 'vm-a', 'critical'),
        finding(BUSY, 'vm-b', 'low'), finding(BUSY, 'vm-c', 'low'),
      ],
    });

    expect((await topRules()).map(r => [r.ruleId, r.count, r.severity])).toEqual([[BUSY, 2, 'low'], [MIXED, 1, 'critical']]);
  });
});
