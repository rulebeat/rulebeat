/**
 * Spec 032 — Directory rule authoring (Microsoft Graph).
 *
 * runGraphRules() is the Graph-backend counterpart to runner.ts's runRules(): same
 * RuleRunEvent/RuleExecutionStatus contract (success/failed/capped/invalid), but Graph-shaped
 * internals (ctx.graphGet() instead of ctx.queryARG(), no ARM id to parse, per-item expansion
 * instead of one-row-one-finding only). This suite pins that contract directly, the same way
 * runner-outcomes.test.ts pins runner.ts's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenCredential } from '@azure/identity';
import { buildGraphPath, runGraphRules } from '../src/engine/graph-runner.js';
import { GraphTruncatedError } from '../src/auth/index.js';
import type { GraphQuery, Rule, RuleRunEvent } from '../src/engine/types.js';
import type { Finding, LogFields, TenantContext } from '../src/types.js';

interface CapturedLog { message: string; fields?: LogFields }

function baseRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'test-graph-rule',
    name: 'Test Graph rule',
    description: 'desc',
    category: 'identity',
    severity: 'medium',
    enabled: true,
    type: 'custom',
    queryBackend: 'microsoft-graph',
    scope: { level: 'resource' },
    resourceTypes: [],
    conditions: [],
    graphQuery: { path: 'applications' },
    ...overrides,
  };
}

type FakeGraphGet = (path: string) => Promise<Record<string, unknown>[]>;

function fakeCtx(graphGet: FakeGraphGet | undefined, logs: CapturedLog[] = []): TenantContext {
  return {
    tenantId: 'test-tenant',
    subscriptionIds: ['sub-1'],
    credential: {} as TokenCredential,
    log: (message, fields) => { logs.push({ message, fields }); },
    queryARG: async () => { throw new Error('runGraphRules must never call queryARG'); },
    // fakeTenantContext()'s omitGraphGet fixture (packages/web) does the same deliberate
    // runtime-only violation of the required-graphGet type, for the same reason.
    graphGet: graphGet as unknown as TenantContext['graphGet'],
  };
}

async function drain(rules: Rule[], ctx: TenantContext): Promise<RuleRunEvent<Finding>[]> {
  const out: RuleRunEvent<Finding>[] = [];
  for await (const event of runGraphRules(rules, ctx)) out.push(event);
  return out;
}

const NOW = new Date('2026-01-01T00:00:00.000Z');

function isoDaysFromNow(days: number): string {
  return new Date(NOW.getTime() + days * 86_400_000).toISOString();
}

const BANDS = [
  { maxDays: 7, severity: 'critical' as const },
  { maxDays: 14, severity: 'high' as const },
  { maxDays: 30, severity: 'medium' as const },
];

const EXPAND_GQ: GraphQuery = {
  path: 'applications',
  expand: {
    arrayField: 'passwordCredentials',
    dateField: 'endDateTime',
    itemIdField: 'keyId',
    resourceType: 'microsoft.aad/applications/secrets',
    bands: BANDS,
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildGraphPath()', () => {
  it('returns the bare path when there is no filter or expand', () => {
    expect(buildGraphPath({ path: 'users' })).toBe('/users');
  });

  it('adds $select with id, displayName and the array field for an expand query', () => {
    const path = buildGraphPath({
      path: 'servicePrincipals',
      expand: { arrayField: 'keyCredentials', dateField: 'endDateTime', itemIdField: 'keyId', resourceType: 'x', bands: [] },
    });
    expect(path).toBe('/servicePrincipals?$select=id,displayName,keyCredentials');
  });

  it('adds appId to $select only for applications + expand', () => {
    const path = buildGraphPath({
      path: 'applications',
      expand: { arrayField: 'passwordCredentials', dateField: 'endDateTime', itemIdField: 'keyId', resourceType: 'x', bands: [] },
    });
    expect(path).toBe('/applications?$select=id,displayName,passwordCredentials,appId');
  });

  it('does not add appId for a non-applications expand path', () => {
    const path = buildGraphPath({
      path: 'servicePrincipals',
      expand: { arrayField: 'keyCredentials', dateField: 'endDateTime', itemIdField: 'keyId', resourceType: 'x', bands: [] },
    });
    expect(path).not.toContain('appId');
  });

  it('does not add a $select at all when there is no expand', () => {
    expect(buildGraphPath({ path: 'applications', filter: "startswith(displayName,'x')" }))
      .not.toContain('$select');
  });

  it('URL-encodes the $filter expression', () => {
    expect(buildGraphPath({ path: 'users', filter: 'accountEnabled eq false' }))
      .toBe(`/users?$filter=${encodeURIComponent('accountEnabled eq false')}`);
  });

  it('combines $select and $filter with &, in that order', () => {
    const path = buildGraphPath({
      path: 'applications',
      filter: "startswith(displayName,'x')",
      expand: { arrayField: 'keyCredentials', dateField: 'endDateTime', itemIdField: 'keyId', resourceType: 'x', bands: [] },
    });
    expect(path).toBe(
      `/applications?$select=id,displayName,keyCredentials,appId&$filter=${encodeURIComponent("startswith(displayName,'x')")}`,
    );
  });
});

describe('runGraphRules() outcomes', () => {
  it('yields success with one finding per Graph object when there is no expand', async () => {
    const rule = baseRule();
    const ctx = fakeCtx(async () => [{ id: 'obj-1', displayName: 'Object One' }]);

    const events = await drain([rule], ctx);
    const findings = events.filter(e => e.kind === 'finding');
    const outcomes = events.filter(e => e.kind === 'outcome');

    expect(findings).toHaveLength(1);
    const finding = findings[0].kind === 'finding' ? findings[0].finding : undefined;
    expect(finding?.resourceId).toBe('applications/obj-1');
    expect(finding?.resourceType).toBe('microsoft.graph/applications');
    expect(finding?.resourceName).toBe('Object One');
    expect(finding?.severity).toBe(rule.severity);
    expect(finding?.azurePortalLink).toBeUndefined();
    expect(outcomes).toEqual([{ kind: 'outcome', outcome: { ruleId: rule.id, status: 'success', findingCount: 1 } }]);
  });

  it('falls back to the object id as resourceName when displayName is absent', async () => {
    const rule = baseRule();
    const ctx = fakeCtx(async () => [{ id: 'obj-1' }]);

    const events = await drain([rule], ctx);
    const finding = events.find(e => e.kind === 'finding');
    expect(finding?.kind === 'finding' ? finding.finding.resourceName : undefined).toBe('obj-1');
  });

  it('skips a disabled rule entirely — no query, no events', async () => {
    const rule = baseRule({ enabled: false });
    const ctx = fakeCtx(async () => { throw new Error('graphGet must not be called for a disabled rule'); });

    const events = await drain([rule], ctx);
    expect(events).toEqual([]);
  });

  it('yields failed with no findings when the rule has no graphQuery configured', async () => {
    const rule = baseRule({ graphQuery: undefined });
    const ctx = fakeCtx(async () => [{ id: 'obj-1' }]);

    const events = await drain([rule], ctx);
    expect(events).toEqual([{ kind: 'outcome', outcome: { ruleId: rule.id, status: 'failed', findingCount: 0 } }]);
  });

  it('yields failed with no findings when the context has no graphGet configured', async () => {
    const rule = baseRule();
    const ctx = fakeCtx(undefined);

    const events = await drain([rule], ctx);
    expect(events).toEqual([{ kind: 'outcome', outcome: { ruleId: rule.id, status: 'failed', findingCount: 0 } }]);
  });

  it('yields failed, not capped, for a generic query error', async () => {
    const rule = baseRule();
    const ctx = fakeCtx(async () => { throw new Error('graph is down'); });

    const events = await drain([rule], ctx);
    expect(events).toEqual([{ kind: 'outcome', outcome: { ruleId: rule.id, status: 'failed', findingCount: 0 } }]);
  });

  it('yields capped, not success, when the Graph result set is truncated ("Fails today" — spec 032 Tests #2)', async () => {
    const rule = baseRule();
    const ctx = fakeCtx(async () => { throw new GraphTruncatedError(10_001); });

    const events = await drain([rule], ctx);
    expect(events).toEqual([{ kind: 'outcome', outcome: { ruleId: rule.id, status: 'capped', findingCount: 0 } }]);
  });

  it("isolates one rule's query failure from another rule's success in the same run (\"Fails today\" — spec 032 Tests #1 / RB-RM-011)", async () => {
    const failing = baseRule({ id: 'rule-a', graphQuery: { path: 'applications' } });
    const succeeding = baseRule({ id: 'rule-b', graphQuery: { path: 'users' } });
    const ctx = fakeCtx(async (path: string) => {
      if (path === '/applications') throw new Error('rule-a query is broken');
      return [{ id: 'obj-1', displayName: 'Object One' }];
    });

    const events = await drain([failing, succeeding], ctx);
    const outcomes = events.filter(e => e.kind === 'outcome').map(e => (e.kind === 'outcome' ? e.outcome : null));

    expect(outcomes).toEqual([
      { ruleId: 'rule-a', status: 'failed', findingCount: 0 },
      { ruleId: 'rule-b', status: 'success', findingCount: 1 },
    ]);
    // rule-b's finding must still have been yielded — one bad rule must not swallow another's results.
    expect(events.filter(e => e.kind === 'finding')).toHaveLength(1);
  });

  it('skips rows with a blank id and downgrades the outcome to invalid (mirrors spec 005)', async () => {
    const rule = baseRule();
    const ctx = fakeCtx(async () => [
      { id: 'obj-1', displayName: 'Good' },
      { id: '   ', displayName: 'Blank id' },
      { id: '', displayName: 'Empty id' },
    ]);

    const events = await drain([rule], ctx);
    const findings = events.filter(e => e.kind === 'finding');
    const outcomes = events.filter(e => e.kind === 'outcome');

    expect(findings).toHaveLength(1);
    expect(outcomes).toEqual([{ kind: 'outcome', outcome: { ruleId: rule.id, status: 'invalid', findingCount: 1 } }]);
  });

  it('yields success with zero findings for an empty Graph result', async () => {
    const rule = baseRule();
    const ctx = fakeCtx(async () => []);

    const events = await drain([rule], ctx);
    expect(events).toEqual([{ kind: 'outcome', outcome: { ruleId: rule.id, status: 'success', findingCount: 0 } }]);
  });
});

describe('runGraphRules() expand / severity banding (spec 032 Decision 1, spec 032 Tests #3 groundwork)', () => {
  it('assigns the tightest matching band severity at each exact boundary, tightest-first', async () => {
    const rule = baseRule({ graphQuery: EXPAND_GQ });
    const ctx = fakeCtx(async () => [{
      id: 'app-1',
      displayName: 'App One',
      appId: 'client-1',
      passwordCredentials: [
        { keyId: 'k-critical', endDateTime: isoDaysFromNow(7) },
        { keyId: 'k-high', endDateTime: isoDaysFromNow(14) },
        { keyId: 'k-medium', endDateTime: isoDaysFromNow(30) },
        { keyId: 'k-outside', endDateTime: isoDaysFromNow(31) },
      ],
    }]);

    const events = await drain([rule], ctx);
    const findings = events
      .filter((e): e is { kind: 'finding'; finding: Finding } => e.kind === 'finding')
      .map(e => e.finding);

    expect(findings.map(f => f.severity)).toEqual(['critical', 'high', 'medium']);
    expect(findings.map(f => f.resourceId)).toEqual([
      'applications/app-1/passwordCredentials/k-critical',
      'applications/app-1/passwordCredentials/k-high',
      'applications/app-1/passwordCredentials/k-medium',
    ]);
    expect(findings.every(f => f.resourceType === 'microsoft.aad/applications/secrets')).toBe(true);
  });

  it('yields success with zero findings when every item sits outside every band\'s window', async () => {
    const rule = baseRule({ graphQuery: EXPAND_GQ });
    const ctx = fakeCtx(async () => [{
      id: 'app-1',
      displayName: 'App One',
      passwordCredentials: [{ keyId: 'k1', endDateTime: isoDaysFromNow(90) }],
    }]);

    const events = await drain([rule], ctx);
    expect(events).toEqual([{ kind: 'outcome', outcome: { ruleId: rule.id, status: 'success', findingCount: 0 } }]);
  });

  it('skips an object whose array field is absent or not an array, without erroring', async () => {
    const rule = baseRule({ graphQuery: EXPAND_GQ });
    const ctx = fakeCtx(async () => [
      { id: 'app-1', displayName: 'No creds field at all' },
      { id: 'app-2', displayName: 'Wrong shape', passwordCredentials: 'not-an-array' },
    ]);

    const events = await drain([rule], ctx);
    expect(events).toEqual([{ kind: 'outcome', outcome: { ruleId: rule.id, status: 'success', findingCount: 0 } }]);
  });

  it('skips an item whose date field is missing, null, or non-string', async () => {
    const rule = baseRule({ graphQuery: EXPAND_GQ });
    const ctx = fakeCtx(async () => [{
      id: 'app-1',
      displayName: 'App',
      passwordCredentials: [
        { keyId: 'k1' },
        { keyId: 'k2', endDateTime: null },
        { keyId: 'k3', endDateTime: 12_345 },
      ],
    }]);

    const events = await drain([rule], ctx);
    expect(events).toEqual([{ kind: 'outcome', outcome: { ruleId: rule.id, status: 'success', findingCount: 0 } }]);
  });

  it('stamps evidence with daysRemaining alongside the raw expanded-item fields', async () => {
    const rule = baseRule({ graphQuery: EXPAND_GQ });
    const ctx = fakeCtx(async () => [{
      id: 'app-1',
      displayName: 'App',
      passwordCredentials: [{ keyId: 'k1', endDateTime: isoDaysFromNow(5), hint: 'AB' }],
    }]);

    const events = await drain([rule], ctx);
    const finding = events.find((e): e is { kind: 'finding'; finding: Finding } => e.kind === 'finding');
    expect(finding?.finding.evidence).toMatchObject({ keyId: 'k1', hint: 'AB', daysRemaining: 5 });
  });

  it('expands multiple objects independently in one rule run', async () => {
    const rule = baseRule({ graphQuery: EXPAND_GQ });
    const ctx = fakeCtx(async () => [
      { id: 'app-1', displayName: 'App One', passwordCredentials: [{ keyId: 'k1', endDateTime: isoDaysFromNow(5) }] },
      { id: 'app-2', displayName: 'App Two', passwordCredentials: [{ keyId: 'k2', endDateTime: isoDaysFromNow(5) }] },
    ]);

    const events = await drain([rule], ctx);
    const findings = events.filter(e => e.kind === 'finding');
    expect(findings).toHaveLength(2);
    expect(events).toContainEqual({ kind: 'outcome', outcome: { ruleId: rule.id, status: 'success', findingCount: 2 } });
  });
});

describe('runGraphRules() portal links', () => {
  it('builds a portal link for an applications + expand finding, keyed on appId', async () => {
    const rule = baseRule({ graphQuery: EXPAND_GQ });
    const ctx = fakeCtx(async () => [{
      id: 'app-1',
      displayName: 'App',
      appId: 'client-abc',
      passwordCredentials: [{ keyId: 'k1', endDateTime: isoDaysFromNow(5) }],
    }]);

    const events = await drain([rule], ctx);
    const finding = events.find((e): e is { kind: 'finding'; finding: Finding } => e.kind === 'finding');
    expect(finding?.finding.azurePortalLink).toBe(
      'https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/Credentials/appId/client-abc',
    );
  });

  it('omits the portal link for a plain (non-expand) applications finding', async () => {
    const rule = baseRule({ graphQuery: { path: 'applications' } });
    const ctx = fakeCtx(async () => [{ id: 'app-1', displayName: 'App', appId: 'client-abc' }]);

    const events = await drain([rule], ctx);
    const finding = events.find((e): e is { kind: 'finding'; finding: Finding } => e.kind === 'finding');
    expect(finding?.finding.azurePortalLink).toBeUndefined();
  });

  it('omits the portal link for a non-applications path even with expand', async () => {
    const rule = baseRule({
      graphQuery: {
        path: 'servicePrincipals',
        expand: {
          arrayField: 'keyCredentials',
          dateField: 'endDateTime',
          itemIdField: 'keyId',
          resourceType: 'microsoft.aad/serviceprincipals/certificates',
          bands: BANDS,
        },
      },
    });
    const ctx = fakeCtx(async () => [{
      id: 'sp-1',
      displayName: 'SP',
      keyCredentials: [{ keyId: 'k1', endDateTime: isoDaysFromNow(5) }],
    }]);

    const events = await drain([rule], ctx);
    const finding = events.find((e): e is { kind: 'finding'; finding: Finding } => e.kind === 'finding');
    expect(finding?.finding.azurePortalLink).toBeUndefined();
  });
});
