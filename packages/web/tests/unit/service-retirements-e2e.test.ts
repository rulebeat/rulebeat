/**
 * Issue #181, end to end: the Service retirements rule RuleBeat Core ships scans through
 * runCategoryScan() with the fake Azure context answering as Azure Advisor would. Each affected
 * resource becomes one Advisory keyed on its resource id, carrying the retirement date as its
 * Deadline and the retiring feature as its group, and none of it enters a posture or problem count.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCategory } from '@/lib/db/categories';
import { createUser } from '@/lib/db/users';
import { runCategoryScan } from '@/lib/scan-runner';
import { listFindings } from '@/lib/db/findings';
import { computeWidgetSummary } from '@/lib/dashboard-data';
import { buildExplorerData } from '@/lib/explorer-data';
import { groupAdvisories } from '@/lib/advisory-groups';
import { resetDb } from '../helpers/db';
import { SERVICE_RETIREMENTS_RULE_ID } from '../helpers/catalogue';
import { fakeTenantContext, TEST_SUB_A } from '../helpers/fake-azure';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const NOW = new Date('2026-06-15T12:00:00.000Z');
const resourceId = (provider: string, name: string) =>
  `/subscriptions/${TEST_SUB_A}/resourcegroups/rg-legacy/providers/${provider}/${name}`;

const REDIS = resourceId('microsoft.cache', 'redis/cache-one');
const SITE = resourceId('microsoft.web', 'sites/app-one');
const VM = resourceId('microsoft.compute', 'virtualmachines/vm-one');

/** A row shaped like the rule's own `| project`; the id is whatever the caller says Advisor returned. */
function retirementRow(id: string, feature: string, date: string): Record<string, unknown> {
  return {
    id,
    name: id.split('/').pop(),
    subscriptionId: TEST_SUB_A,
    resourceGroup: 'rg-legacy',
    retirementFeatureName: feature,
    retirementDate: date,
    shortDescription: `${feature} is being retired`,
    recommendationTypeId: '00000000-0000-0000-0000-00000000abcd',
  };
}

let advisorRows: () => Record<string, unknown>[];

async function scan() {
  const category = (await getCategory('reliability'))!;
  const ctx = fakeTenantContext({
    // Only the rule's own query reads `advisorresources`; the location follow-up gets nothing back.
    rows: kql => (/^\s*advisorresources/i.test(kql) ? advisorRows() : []),
  });
  const outcome = await runCategoryScan(category, { ctx, ruleIds: [SERVICE_RETIREMENTS_RULE_ID] });
  return { ctx, outcome };
}

const advisories = () => buildExplorerData({ kinds: ['advisory'], now: NOW });
const mine = async () => (await listFindings()).filter(f => f.ruleId === SERVICE_RETIREMENTS_RULE_ID);

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  advisorRows = () => [
    retirementRow(REDIS, 'Azure Cache for Redis Basic and Standard tiers', '2026-09-30'),
    retirementRow(SITE, 'App Service Linux on Python 3.8', '2026-12-31T00:00:00Z'),
    retirementRow(VM, 'App Service Linux on Python 3.8', '2027-03-01'),
  ];
  const viewer = await createUser({ email: 'viewer@example.com', role: 'viewer' });
  if ('error' in viewer) throw new Error(viewer.error);
  mockAuth.mockResolvedValue({ user: { uid: viewer.user.id } });
});

describe('the resource id the rule reports', () => {
  const MIXED = `/subscriptions/${TEST_SUB_A}/resourceGroups/RG-Prod/providers/Microsoft.Compute/virtualMachines/VM-01`;

  /**
   * Fake Azure for one Advisor recommendation whose resource id has mixed case. It evaluates only the
   * rule's own `extend resourceId = ...` line, so the id the rule reports is whatever that line
   * produces from what Advisor holds. The follow-up `resources` query is answered like Resource
   * Graph answers `in`: a row comes back only for an id that matches character for character.
   */
  function advisorWithMixedCaseId() {
    return fakeTenantContext({
      rows: kql => {
        if (/^\s*advisorresources/i.test(kql)) {
          const expr = /\|\s*extend\s+resourceId\s*=\s*(.+)/.exec(kql)?.[1] ?? '';
          const id = /^tolower\(/i.test(expr.trim()) ? MIXED.toLowerCase() : MIXED;
          return [retirementRow(id, 'Azure Cache for Redis Basic and Standard tiers', '2026-09-30')];
        }
        const asked = [...kql.matchAll(/'((?:[^']|'')*)'/g)].map(m => m[1].replace(/''/g, "'"));
        return asked.includes(MIXED)
          ? [{ id: MIXED, type: 'microsoft.compute/virtualmachines', location: 'westeurope', resourceGroup: 'RG-Prod', subscriptionId: TEST_SUB_A }]
          : [];
      },
    });
  }

  it('lets a resource with a mixed-case id get its location from the follow-up query', async () => {
    const category = (await getCategory('reliability'))!;
    await runCategoryScan(category, { ctx: advisorWithMixedCaseId(), ruleIds: [SERVICE_RETIREMENTS_RULE_ID] });
    const [finding, ...rest] = await mine();
    expect(rest).toEqual([]);
    expect(finding.location).toBe('westeurope');
    expect(finding.resourceId).toBe(MIXED);
  });
});

describe('scanning the shipped Service retirements rule', () => {
  it('yields one Advisory per affected resource, keyed on the resource id, with its Deadline and group', async () => {
    const { outcome } = await scan();
    expect(outcome.summary.incompleteRules).toEqual([]);
    expect(outcome.summary.coverage).not.toBe('partial');

    const found = await mine();
    expect(found.map(f => f.resourceId).sort()).toEqual([REDIS, SITE, VM].sort());
    const byId = (id: string) => found.find(f => f.resourceId === id)!;
    expect(byId(REDIS).deadline).toBe('2026-09-30T00:00:00.000Z');
    expect(byId(REDIS).groupValue).toBe('Azure Cache for Redis Basic and Standard tiers');
    expect(byId(SITE).deadline).toBe('2026-12-31T00:00:00.000Z');
    expect(byId(SITE).groupValue).toBe('App Service Linux on Python 3.8');
    expect(byId(VM).deadline).toBe('2027-03-01T00:00:00.000Z');
    expect(found.every(f => f.status === 'active')).toBe(true);

    const { findings } = await advisories();
    expect(findings.filter(f => f.ruleId === SERVICE_RETIREMENTS_RULE_ID)).toHaveLength(3);
  });

  it('groups the Advisories by retiring feature, one group per feature', async () => {
    await scan();
    const [rule, ...rest] = groupAdvisories((await advisories()).findings);
    expect(rest).toEqual([]);
    expect(rule.ruleId).toBe(SERVICE_RETIREMENTS_RULE_ID);
    expect(rule.groups.map(g => g.groupValue).sort()).toEqual([
      'App Service Linux on Python 3.8',
      'Azure Cache for Redis Basic and Standard tiers',
    ]);
    expect(rule.groups.find(g => g.groupValue === 'App Service Linux on Python 3.8')!.findings).toHaveLength(2);
  });

  it('records a resource that is affected by two retirements as one Advisory, never two', async () => {
    advisorRows = () => [
      retirementRow(REDIS, 'Azure Cache for Redis Basic and Standard tiers', '2026-09-30'),
      retirementRow(REDIS, 'Azure Cache for Redis TLS 1.0 and 1.1', '2026-11-01'),
    ];
    await scan();
    expect(await mine()).toHaveLength(1);
  });

  it('resolves an Advisory when Advisor stops reporting the resource, and leaves the others open', async () => {
    await scan();
    advisorRows = () => [retirementRow(SITE, 'App Service Linux on Python 3.8', '2026-12-31T00:00:00Z')];
    const { outcome } = await scan();
    expect(outcome.summary.incompleteRules).toEqual([]);
    const found = await mine();
    expect(found.find(f => f.resourceId === REDIS)!.status).toBe('fixed');
    expect(found.find(f => f.resourceId === VM)!.status).toBe('fixed');
    expect(found.find(f => f.resourceId === SITE)!.status).toBe('active');
  });

  it('asks Advisor with its own query, which carries no top-level take, limit or top', async () => {
    const { ctx } = await scan();
    const own = ctx.queries.find(q => /^\s*advisorresources/i.test(q.kql));
    expect(own, 'the scan never issued the rule query').toBeDefined();
    expect(own!.kql).toContain('ServiceUpgradeAndRetirement');
    expect(own!.kql).not.toMatch(/\|\s*(take|limit|top)\b/i);
  });

  it('never enters a posture or problem count', async () => {
    await scan();
    const summary = await computeWidgetSummary({ categories: ['reliability'], dateWindow: { mode: 'relative', days: 7 } }, 30);
    expect(summary.current.activeFindings).toBe(0);
  });
});
