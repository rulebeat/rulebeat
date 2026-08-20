/**
 * WS2g · the identity category's Graph seam.
 *
 * Spec 032 removed `lib/identity-scan.ts` and its hardcoded `collectIdentityFindings()` entirely —
 * the two identity rules (`cred:app-secret-expiring`, `cred:app-cert-expiring`, seeded in
 * `lib/builtin-rules.ts`) are now ordinary `queryBackend: 'microsoft-graph'` rows, evaluated by the
 * generic `runGraphRules()` engine (packages/core/src/engine/graph-runner.ts) through its per-item
 * `graphQuery.expand` mechanism — no rule-specific code path left anywhere.
 *
 * This suite proves that engine reproduces the credential-expiry behaviour end to end against the
 * fake Graph seam, with no network involved at any point. Rule fixtures below mirror the real
 * builtin rows' `graphQuery` shape exactly; if that shape ever drifts from `lib/builtin-rules.ts`,
 * update both together.
 */
import { describe, expect, it } from 'vitest';
import { runGraphRules } from '@rulebeat/core';
import type { Finding, Rule, RuleRunEvent } from '@rulebeat/core';
import { fakeTenantContext, type FakeTenantContext } from '../helpers/fake-azure';

function isoInDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

const BANDS = [
  { maxDays: 7, severity: 'critical' as const },
  { maxDays: 14, severity: 'high' as const },
  { maxDays: 30, severity: 'medium' as const },
];

function secretRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'cred:app-secret-expiring',
    type: 'builtin',
    pack: 'rulebeat-core',
    name: 'App Registration Secret Expiring',
    description: 'A client secret on an app registration is expiring soon.',
    category: 'identity',
    severity: 'medium',
    enabled: true,
    scope: { level: 'resource' },
    resourceTypes: [],
    conditions: [],
    queryBackend: 'microsoft-graph',
    graphQuery: {
      path: 'applications',
      expand: {
        arrayField: 'passwordCredentials',
        dateField: 'endDateTime',
        itemIdField: 'keyId',
        resourceType: 'microsoft.aad/applications/secrets',
        bands: BANDS,
      },
    },
    ...overrides,
  };
}

function certRule(overrides: Partial<Rule> = {}): Rule {
  return {
    ...secretRule(),
    id: 'cred:app-cert-expiring',
    name: 'App Registration Certificate Expiring',
    description: 'A certificate credential on an app registration is expiring soon.',
    graphQuery: {
      path: 'applications',
      expand: {
        arrayField: 'keyCredentials',
        dateField: 'endDateTime',
        itemIdField: 'keyId',
        resourceType: 'microsoft.aad/applications/certificates',
        bands: BANDS,
      },
    },
    ...overrides,
  };
}

type FindingEvent = Extract<RuleRunEvent<Finding>, { kind: 'finding' }>;

async function drain(rules: Rule[], ctx: FakeTenantContext): Promise<RuleRunEvent<Finding>[]> {
  const out: RuleRunEvent<Finding>[] = [];
  for await (const event of runGraphRules(rules, ctx)) out.push(event);
  return out;
}

describe('runGraphRules() against the fake Graph seam (identity rules)', () => {
  it('calls graphGet once per rule with its own $select path, and never touches queryARG', async () => {
    const ctx = fakeTenantContext({ graphRows: [] });
    await drain([secretRule(), certRule()], ctx);

    expect(ctx.graphRequests).toEqual([
      '/applications?$select=id,displayName,passwordCredentials,appId',
      '/applications?$select=id,displayName,keyCredentials,appId',
    ]);
    expect(ctx.queries).toEqual([]);
  });

  it('produces a finding for a secret expiring within the 30-day warn window', async () => {
    const ctx = fakeTenantContext({
      graphRows: [{
        id: 'app-1',
        displayName: 'Contoso Sync Service',
        appId: 'aaaa1111-0000-0000-0000-000000000000',
        passwordCredentials: [{ displayName: 'sync-secret', endDateTime: isoInDays(10), keyId: 'k1' }],
      }],
    });

    const events = await drain([secretRule()], ctx);
    const findings = events.filter((e): e is FindingEvent => e.kind === 'finding');
    const outcomes = events.filter(e => e.kind === 'outcome');

    expect(findings).toHaveLength(1);
    const finding = findings[0]!.finding;
    expect(finding.ruleId).toBe('cred:app-secret-expiring');
    expect(finding.resourceName).toBe('Contoso Sync Service');
    expect(finding.resourceId).toBe('applications/app-1/passwordCredentials/k1');
    expect(finding.resourceType).toBe('microsoft.aad/applications/secrets');
    expect(finding.evidence).toMatchObject({ displayName: 'sync-secret', keyId: 'k1', daysRemaining: 10 });
    expect(finding.azurePortalLink).toBe(
      'https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/Credentials/appId/aaaa1111-0000-0000-0000-000000000000',
    );
    expect(outcomes).toEqual([
      { kind: 'outcome', outcome: { ruleId: 'cred:app-secret-expiring', status: 'success', findingCount: 1 } },
    ]);
  });

  it('produces a finding for a certificate expiring within the warn window', async () => {
    const ctx = fakeTenantContext({
      graphRows: [{
        id: 'app-2',
        displayName: 'Contoso Data Pipeline',
        appId: 'bbbb2222-0000-0000-0000-000000000000',
        keyCredentials: [{ displayName: 'pipeline-cert', endDateTime: isoInDays(20), keyId: 'k2' }],
      }],
    });

    const events = await drain([certRule()], ctx);
    const findings = events.filter((e): e is FindingEvent => e.kind === 'finding');

    expect(findings).toHaveLength(1);
    expect(findings[0]!.finding.ruleId).toBe('cred:app-cert-expiring');
    expect(findings[0]!.finding.resourceId).toBe('applications/app-2/keyCredentials/k2');
    expect(findings[0]!.finding.resourceType).toBe('microsoft.aad/applications/certificates');
  });

  it('ignores credentials with no expiry and credentials expiring beyond the warn window', async () => {
    const ctx = fakeTenantContext({
      graphRows: [{
        id: 'app-3',
        displayName: 'Contoso Long-Lived App',
        appId: 'cccc3333-0000-0000-0000-000000000000',
        passwordCredentials: [
          { displayName: 'no-expiry', keyId: 'k3' },
          { displayName: 'far-future', endDateTime: isoInDays(365), keyId: 'k4' },
        ],
      }],
    });

    const events = await drain([secretRule()], ctx);

    expect(events).toEqual([
      { kind: 'outcome', outcome: { ruleId: 'cred:app-secret-expiring', status: 'success', findingCount: 0 } },
    ]);
  });

  it('assigns severity by days remaining: critical <= 7, high <= 14, medium otherwise', async () => {
    const ctx = fakeTenantContext({
      graphRows: [{
        id: 'app-4',
        displayName: 'Contoso Multi-Secret App',
        appId: 'dddd4444-0000-0000-0000-000000000000',
        passwordCredentials: [
          { displayName: 'critical-secret', endDateTime: isoInDays(3), keyId: 'k5' },
          { displayName: 'high-secret', endDateTime: isoInDays(12), keyId: 'k6' },
          { displayName: 'medium-secret', endDateTime: isoInDays(25), keyId: 'k7' },
        ],
      }],
    });

    const events = await drain([secretRule()], ctx);
    const findings = events.filter((e): e is FindingEvent => e.kind === 'finding').map(e => e.finding);
    const byLabel = Object.fromEntries(findings.map(f => [(f.evidence as { displayName: string }).displayName, f.severity]));

    expect(byLabel).toEqual({
      'critical-secret': 'critical',
      'high-secret': 'high',
      'medium-secret': 'medium',
    });
  });

  it('reports a failed outcome, not a thrown rejection, when graphGet fails', async () => {
    const ctx = fakeTenantContext({ graphFailWith: new Error('503 from graph.microsoft.com') });

    const events = await drain([secretRule()], ctx);

    expect(events).toEqual([
      { kind: 'outcome', outcome: { ruleId: 'cred:app-secret-expiring', status: 'failed', findingCount: 0 } },
    ]);
    const outcomeLog = ctx.logFields.find(f => f.operation === 'rule-outcome');
    expect(outcomeLog).toMatchObject({
      ruleId: 'cred:app-secret-expiring',
      category: 'identity',
      status: 'failed',
      level: 'error',
    });
    const logIndex = ctx.logs.findIndex(m => m.includes('503 from graph.microsoft.com'));
    expect(logIndex).toBeGreaterThanOrEqual(0);
  });

  it('reports a failed outcome with a clear message when the context has no Graph access configured', async () => {
    const ctx = fakeTenantContext({ omitGraphGet: true });

    const events = await drain([secretRule()], ctx);

    expect(events).toEqual([
      { kind: 'outcome', outcome: { ruleId: 'cred:app-secret-expiring', status: 'failed', findingCount: 0 } },
    ]);
    const logIndex = ctx.logs.findIndex(m => /no Graph access configured/i.test(m));
    expect(logIndex).toBeGreaterThanOrEqual(0);
  });

  it('keeps one rule\'s Graph failure from aborting a sibling rule in the same scan (RB-RM-011)', async () => {
    const ctx = fakeTenantContext({
      graphRows: (path: string) => {
        if (path.includes('passwordCredentials')) throw new Error('503 from graph.microsoft.com');
        return [{
          id: 'app-2',
          displayName: 'Contoso Data Pipeline',
          appId: 'bbbb2222-0000-0000-0000-000000000000',
          keyCredentials: [{ displayName: 'pipeline-cert', endDateTime: isoInDays(5), keyId: 'k2' }],
        }];
      },
    });

    const events = await drain([secretRule(), certRule()], ctx);
    const outcomes = events.filter(e => e.kind === 'outcome');

    expect(outcomes).toEqual([
      { kind: 'outcome', outcome: { ruleId: 'cred:app-secret-expiring', status: 'failed', findingCount: 0 } },
      { kind: 'outcome', outcome: { ruleId: 'cred:app-cert-expiring', status: 'success', findingCount: 1 } },
    ]);
  });
});
