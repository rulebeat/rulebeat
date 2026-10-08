/**
 * Issue #181, end to end: the Service retirements rule RuleBeat Core ships scans through
 * runCategoryScan() with the fake Azure context answering as Azure Advisor would. Each affected
 * resource becomes one Advisory keyed on its resource id, and none of it enters a posture or problem
 * count. Every retirement is kept: a recommendation with no feature name is labelled with its
 * problem text, carries the retirement date when it has one, and always carries its type id.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCategory } from '@/lib/db/categories';
import { createUser } from '@/lib/db/users';
import { runCategoryScan } from '@/lib/scan-runner';
import { listFindings } from '@/lib/db/findings';
import { computeWidgetSummary } from '@/lib/dashboard-data';
import { buildExplorerData } from '@/lib/explorer-data';
import { resetDb } from '../helpers/db';
import { SERVICE_RETIREMENTS_RULE_ID } from '../helpers/catalogue';
import { fakeTenantContext, TEST_SUB_A } from '../helpers/fake-azure';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const resourceId = (provider: string, name: string) =>
  `/subscriptions/${TEST_SUB_A}/resourcegroups/rg-legacy/providers/${provider}/${name}`;

const REDIS = resourceId('microsoft.cache', 'redis/cache-one');
const SITE = resourceId('microsoft.web', 'sites/app-one');
const VM = resourceId('microsoft.compute', 'virtualmachines/vm-one');

const TYPE_ID = '00000000-0000-0000-0000-00000000abcd';

/** What Azure Advisor holds for one recommendation, before the rule's query shapes it. */
interface Recommendation {
  resourceId: string;
  feature?: string;
  problem: string;
  date?: string;
  typeId?: string;
}

const recommendation = (id: string, feature: string | undefined, date?: string): Recommendation => ({
  resourceId: id, feature, problem: `${feature ?? 'A service'} is being retired`, date, typeId: TYPE_ID,
});

/**
 * Answers the rule's own query the way Advisor would, reading the rule's own text for the two
 * decisions this test cares about: what a recommendation with no feature name is labelled with, and
 * whether such a recommendation is dropped. Everything else Advisor does is not modelled here.
 */
function advisorAnswer(kql: string, held: Recommendation[]): Record<string, unknown>[] {
  const labelExpr = /\|\s*extend\s+retiringFeature\s*=\s*(.+)/.exec(kql)?.[1] ?? '';
  const fallsBackToProblem = /iff\(\s*isempty\(tostring\(properties\.extendedProperties\.retirementFeatureName\)\)\s*,\s*tostring\(properties\.shortDescription\.problem\)/.test(labelExpr);
  const dropsNoFeature = /\|\s*where[^\n]*isnotempty\(\s*(retiringFeature|retirementFeatureName)\s*\)/.test(kql);
  return held.flatMap(r => {
    const label = r.feature || (fallsBackToProblem ? r.problem : '');
    if (dropsNoFeature && !label) return [];
    return [{
      id: r.resourceId,
      name: r.resourceId.split('/').pop(),
      subscriptionId: TEST_SUB_A,
      resourceGroup: 'rg-legacy',
      retiringFeature: label,
      retirementDate: r.date ?? '',
      recommendationTypeId: r.typeId ?? '',
    }];
  });
}

let held: Recommendation[];

async function scan() {
  const category = (await getCategory('reliability'))!;
  const ctx = fakeTenantContext({
    // Only the rule's own query reads `advisorresources`; the location follow-up gets nothing back.
    rows: kql => (/^\s*advisorresources/i.test(kql) ? advisorAnswer(kql, held) : []),
  });
  const outcome = await runCategoryScan(category, { ctx, ruleIds: [SERVICE_RETIREMENTS_RULE_ID] });
  return { ctx, outcome };
}

const advisories = () => buildExplorerData({ kinds: ['advisory'] });
const mine = async () => (await listFindings()).filter(f => f.ruleId === SERVICE_RETIREMENTS_RULE_ID);

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  held = [
    recommendation(REDIS, 'Azure Cache for Redis Basic and Standard tiers', '2026-09-30'),
    recommendation(SITE, 'App Service Linux on Python 3.8', '2026-12-31T00:00:00Z'),
    recommendation(VM, 'App Service Linux on Python 3.8', '2027-03-01'),
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
          return advisorAnswer(kql, [recommendation(id, 'Azure Cache for Redis Basic and Standard tiers', '2026-09-30')]);
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
  it('yields one Advisory per affected resource, keyed on the resource id, with its feature, date and type id', async () => {
    const { outcome } = await scan();
    expect(outcome.summary.incompleteRules).toEqual([]);
    expect(outcome.summary.coverage).not.toBe('partial');

    const found = await mine();
    expect(found.map(f => f.resourceId).sort()).toEqual([REDIS, SITE, VM].sort());
    const byId = (id: string) => found.find(f => f.resourceId === id)!;
    expect(byId(REDIS).evidence).toMatchObject({
      retiringFeature: 'Azure Cache for Redis Basic and Standard tiers', retirementDate: '2026-09-30', recommendationTypeId: TYPE_ID,
    });
    expect(byId(SITE).evidence).toMatchObject({ retiringFeature: 'App Service Linux on Python 3.8', retirementDate: '2026-12-31T00:00:00Z' });
    expect(byId(VM).evidence).toMatchObject({ retirementDate: '2027-03-01' });
    expect(found.every(f => f.status === 'active')).toBe(true);

    const { findings } = await advisories();
    expect(findings.filter(f => f.ruleId === SERVICE_RETIREMENTS_RULE_ID)).toHaveLength(3);
  });

  it('keeps a retirement that has no feature name, labelled with its problem text', async () => {
    held = [
      recommendation(REDIS, 'Azure Cache for Redis Basic and Standard tiers', '2026-09-30'),
      { resourceId: SITE, problem: 'Your App Service plan uses a runtime that is being retired', date: '2026-12-31', typeId: TYPE_ID },
    ];
    const { outcome } = await scan();
    expect(outcome.summary.incompleteRules).toEqual([]);

    const found = await mine();
    expect(found.map(f => f.resourceId).sort()).toEqual([REDIS, SITE].sort());
    const site = found.find(f => f.resourceId === SITE)!;
    expect(site.status).toBe('active');
    expect(site.evidence).toMatchObject({
      retiringFeature: 'Your App Service plan uses a runtime that is being retired',
      retirementDate: '2026-12-31',
      recommendationTypeId: TYPE_ID,
    });
  });

  it('keeps a retirement with no feature name and no date, and still carries its type id', async () => {
    held = [{ resourceId: VM, problem: 'This VM image is being retired', typeId: TYPE_ID }];
    await scan();

    const [finding, ...rest] = await mine();
    expect(rest).toEqual([]);
    expect(finding.evidence).toMatchObject({
      retiringFeature: 'This VM image is being retired', recommendationTypeId: TYPE_ID,
    });
    expect(finding.evidence.retirementDate || undefined).toBeUndefined();
  });

  it('records a resource that is affected by two retirements as one Advisory, never two', async () => {
    held = [
      recommendation(REDIS, 'Azure Cache for Redis Basic and Standard tiers', '2026-09-30'),
      recommendation(REDIS, 'Azure Cache for Redis TLS 1.0 and 1.1', '2026-11-01'),
    ];
    await scan();
    expect(await mine()).toHaveLength(1);
  });

  it('resolves an Advisory when Advisor stops reporting the resource, and leaves the others open', async () => {
    await scan();
    held = [recommendation(SITE, 'App Service Linux on Python 3.8', '2026-12-31T00:00:00Z')];
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
