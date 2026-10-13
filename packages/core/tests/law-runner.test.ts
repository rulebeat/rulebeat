/**
 * Spec 036: Log Analytics rule authoring.
 *
 * runLawRules() is the Log Analytics-backend counterpart to runner.ts's runRules() and
 * graph-runner.ts's runGraphRules(): same RuleRunEvent/RuleExecutionStatus contract
 * (success/failed/capped/invalid), but LAW-shaped internals (ctx.queryLogs() instead of
 * queryARG()/graphGet(), no ARM id or Graph object id: findings are 'activity' kind, keyed by an
 * optional per-row dimensionKeyField instead of a resource id). This suite pins that contract
 * directly, the same way graph-runner.test.ts pins runGraphRules()'s.
 */
import { describe, expect, it } from 'vitest';
import type { TokenCredential } from '@azure/identity';
import { runLawRules } from '../src/engine/law-runner.js';
import { LogAnalyticsNotConfiguredError, LogAnalyticsTruncatedError } from '../src/clients/log-analytics.js';
import type { Rule, RuleRunEvent } from '../src/engine/types.js';
import type { Finding, LogFields, TenantContext } from '../src/types.js';

interface CapturedLog { message: string; fields?: LogFields }

function baseRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'test-law-rule',
    name: 'Test Log Analytics rule',
    description: 'desc',
    category: 'identity',
    severity: 'medium',
    enabled: true,
    type: 'custom',
    queryBackend: 'log-analytics',
    scope: { level: 'resource' },
    resourceTypes: [],
    conditions: [],
    logsQuery: { kql: 'SigninLogs | where ResultType != 0', timeWindowDays: 30 },
    ...overrides,
  };
}

type FakeQueryLogs = (kql: string) => Promise<Record<string, unknown>[]>;

const WORKSPACE_CUSTOMER_ID = '99999999-9999-9999-9999-999999999999';

type FakeQueryArg = (kql: string) => Promise<Record<string, unknown>[]>;

// A Logs rule looks its workspace up in Resource Graph (resolveWorkspacePlacement), and nothing else
// it does may reach queryARG. A test that does not care about placement gets a context with no
// workspace id, whose lookup never queries.
function fakeCtx(
  queryLogs: FakeQueryLogs,
  logs: CapturedLog[] = [],
  workspace: { id?: string; queryARG?: FakeQueryArg } = {},
): TenantContext {
  return {
    tenantId: 'test-tenant',
    subscriptionIds: ['sub-1'],
    credential: {} as TokenCredential,
    log: (message, fields) => { logs.push({ message, fields }); },
    queryARG: (workspace.queryARG ?? (async () => { throw new Error('this test does not expect a workspace lookup'); })) as TenantContext['queryARG'],
    graphGet: async () => { throw new Error('runLawRules must never call graphGet'); },
    queryLogs: queryLogs as unknown as TenantContext['queryLogs'],
    logAnalyticsWorkspaceId: workspace.id,
  };
}

function workspaceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '/subscriptions/sub-ws/resourceGroups/rg-logs/providers/Microsoft.OperationalInsights/workspaces/law-1',
    subscriptionId: 'sub-ws',
    resourceGroup: 'rg-logs',
    customerId: WORKSPACE_CUSTOMER_ID,
    ...overrides,
  };
}

async function drain(rules: Rule[], ctx: TenantContext): Promise<RuleRunEvent<Finding>[]> {
  const out: RuleRunEvent<Finding>[] = [];
  for await (const event of runLawRules(rules, ctx)) out.push(event);
  return out;
}

describe('runLawRules() outcomes', () => {
  it('yields success with one finding per row, keyed by dimensionKeyField', async () => {
    const rule = baseRule({ logsQuery: { kql: 'X', timeWindowDays: 30, dimensionKeyField: 'UserId' } });
    const ctx = fakeCtx(async () => [
      { UserId: 'user-1', ResultType: 50126 },
      { UserId: 'user-2', ResultType: 50053 },
    ]);

    const events = await drain([rule], ctx);
    const findings = events.filter((e): e is { kind: 'finding'; finding: Finding } => e.kind === 'finding');
    const outcomes = events.filter(e => e.kind === 'outcome');

    expect(findings).toHaveLength(2);
    expect(findings.map(f => f.finding.dimensionKey)).toEqual(['user-1', 'user-2']);
    expect(findings[0].finding.kind).toBe('activity');
    expect(findings[0].finding.severity).toBe(rule.severity);
    // The run borrows no subscription: a context with no workspace id places nothing.
    expect(findings[0].finding.subscriptionId).toBe('');
    expect(findings[0].finding.placement).toBe('unplaceable');
    expect(outcomes).toEqual([{ kind: 'outcome', outcome: { ruleId: rule.id, status: 'success', findingCount: 2 } }]);
  });

  it("collapses every row onto dimensionKey '' when no dimensionKeyField is configured", async () => {
    const rule = baseRule({ logsQuery: { kql: 'X', timeWindowDays: 30 } });
    const ctx = fakeCtx(async () => [{ Foo: 'a' }, { Foo: 'b' }]);

    const events = await drain([rule], ctx);
    const findings = events.filter((e): e is { kind: 'finding'; finding: Finding } => e.kind === 'finding');

    expect(findings).toHaveLength(2);
    expect(findings.every(f => f.finding.dimensionKey === '')).toBe(true);
    expect(findings.every(f => f.finding.fingerprint === findings[0].finding.fingerprint)).toBe(true);
  });

  it('skips a disabled rule entirely: no query, no events', async () => {
    const rule = baseRule({ enabled: false });
    const ctx = fakeCtx(async () => { throw new Error('queryLogs must not be called for a disabled rule'); });

    const events = await drain([rule], ctx);
    expect(events).toEqual([]);
  });

  it('yields failed with no findings when the rule has no logsQuery configured', async () => {
    const rule = baseRule({ logsQuery: undefined });
    const ctx = fakeCtx(async () => [{ Foo: 'a' }]);

    const events = await drain([rule], ctx);
    expect(events).toEqual([{ kind: 'outcome', outcome: { ruleId: rule.id, status: 'failed', findingCount: 0 } }]);
  });

  it('yields failed with a clear message when no workspace is configured', async () => {
    const rule = baseRule();
    const logs: CapturedLog[] = [];
    const ctx = fakeCtx(async () => { throw new LogAnalyticsNotConfiguredError(); }, logs);

    const events = await drain([rule], ctx);
    expect(events).toEqual([{ kind: 'outcome', outcome: { ruleId: rule.id, status: 'failed', findingCount: 0 } }]);
    const outcomeLog = logs.find(l => l.fields?.operation === 'rule-outcome');
    expect(outcomeLog?.message).toContain('No Log Analytics workspace is configured');
  });

  it('yields failed, not capped, for a generic query error', async () => {
    const rule = baseRule();
    const ctx = fakeCtx(async () => { throw new Error('workspace is down'); });

    const events = await drain([rule], ctx);
    expect(events).toEqual([{ kind: 'outcome', outcome: { ruleId: rule.id, status: 'failed', findingCount: 0 } }]);
  });

  it('yields capped, not success, when the Log Analytics result is truncated', async () => {
    const rule = baseRule();
    const ctx = fakeCtx(async () => { throw new LogAnalyticsTruncatedError(500); });

    const events = await drain([rule], ctx);
    expect(events).toEqual([{ kind: 'outcome', outcome: { ruleId: rule.id, status: 'capped', findingCount: 0 } }]);
  });

  it("isolates one rule's query failure from another rule's success in the same run", async () => {
    const failing = baseRule({ id: 'rule-a', logsQuery: { kql: 'BadQuery', timeWindowDays: 30 } });
    const succeeding = baseRule({ id: 'rule-b', logsQuery: { kql: 'GoodQuery', timeWindowDays: 30 } });
    const ctx = fakeCtx(async (kql: string) => {
      if (kql === 'BadQuery') throw new Error('rule-a query is broken');
      return [{ Foo: 'a' }];
    });

    const events = await drain([failing, succeeding], ctx);
    const outcomes = events.filter(e => e.kind === 'outcome').map(e => (e.kind === 'outcome' ? e.outcome : null));

    expect(outcomes).toEqual([
      { ruleId: 'rule-a', status: 'failed', findingCount: 0 },
      { ruleId: 'rule-b', status: 'success', findingCount: 1 },
    ]);
    // rule-b's finding must still have been yielded. One bad rule must not swallow another's results.
    expect(events.filter(e => e.kind === 'finding')).toHaveLength(1);
  });

  it('skips rows with a blank dimensionKeyField value and downgrades the outcome to invalid', async () => {
    const rule = baseRule({ logsQuery: { kql: 'X', timeWindowDays: 30, dimensionKeyField: 'UserId' } });
    const ctx = fakeCtx(async () => [
      { UserId: 'user-1' },
      { UserId: '   ' },
      { UserId: '' },
    ]);

    const events = await drain([rule], ctx);
    const findings = events.filter(e => e.kind === 'finding');
    const outcomes = events.filter(e => e.kind === 'outcome');

    expect(findings).toHaveLength(1);
    expect(outcomes).toEqual([{ kind: 'outcome', outcome: { ruleId: rule.id, status: 'invalid', findingCount: 1 } }]);
  });

  it('yields success with zero findings for an empty Log Analytics result', async () => {
    const rule = baseRule();
    const ctx = fakeCtx(async () => []);

    const events = await drain([rule], ctx);
    expect(events).toEqual([{ kind: 'outcome', outcome: { ruleId: rule.id, status: 'success', findingCount: 0 } }]);
  });

  // Issue #145: a Log Analytics query with a top-level take/limit/top is just as incomplete as a
  // capped Resource Graph query, and must not report 'success' (runner.ts already makes this check
  // for its own backend via queryHasTopLevelLimit(); law-runner.ts was missing it entirely).
  it('yields capped, not success, for a query ending in a top-level `| take`', async () => {
    const rule = baseRule({ logsQuery: { kql: 'SigninLogs | where ResultType != 0 | take 50', timeWindowDays: 30 } });
    const ctx = fakeCtx(async () => [{ Foo: 'a' }]);

    const events = await drain([rule], ctx);
    const outcomes = events.filter(e => e.kind === 'outcome');

    expect(events.filter(e => e.kind === 'finding')).toHaveLength(1);
    expect(outcomes).toEqual([{ kind: 'outcome', outcome: { ruleId: rule.id, status: 'capped', findingCount: 1 } }]);
  });

  it('yields capped, not success, for a query ending in a top-level `| limit`', async () => {
    const rule = baseRule({ logsQuery: { kql: 'SigninLogs | where ResultType != 0 | limit 10', timeWindowDays: 30 } });
    const ctx = fakeCtx(async () => [{ Foo: 'a' }]);

    const events = await drain([rule], ctx);
    const outcomes = events.filter(e => e.kind === 'outcome');

    expect(events.filter(e => e.kind === 'finding')).toHaveLength(1);
    expect(outcomes).toEqual([{ kind: 'outcome', outcome: { ruleId: rule.id, status: 'capped', findingCount: 1 } }]);
  });

  it('stays success when `take` only appears inside a subquery, not as a top-level stage', async () => {
    const rule = baseRule({
      logsQuery: {
        kql: 'SigninLogs | join kind=inner (AuditLogs | take 5) on CorrelationId',
        timeWindowDays: 30,
      },
    });
    const ctx = fakeCtx(async () => [{ Foo: 'a' }]);

    const events = await drain([rule], ctx);
    const outcomes = events.filter(e => e.kind === 'outcome');

    expect(events.filter(e => e.kind === 'finding')).toHaveLength(1);
    expect(outcomes).toEqual([{ kind: 'outcome', outcome: { ruleId: rule.id, status: 'success', findingCount: 1 } }]);
  });
});

describe('runLawRules() placement', () => {
  const rule = baseRule({ logsQuery: { kql: 'X', timeWindowDays: 30, dimensionKeyField: 'UserId' } });
  const rows = [{ UserId: 'user-1' }, { UserId: 'user-2' }];
  const findingsOf = (events: RuleRunEvent<Finding>[]) =>
    events.filter((e): e is { kind: 'finding'; finding: Finding } => e.kind === 'finding').map(e => e.finding);

  it('places a finding at the workspace, with its subscription and resource group', async () => {
    const ctx = fakeCtx(async () => rows, [], { id: WORKSPACE_CUSTOMER_ID, queryARG: async () => [workspaceRow()] });
    const findings = findingsOf(await drain([rule], ctx));

    expect(findings).toHaveLength(2);
    for (const f of findings) {
      expect(f.placement).toBe('workspace');
      expect(f.subscriptionId).toBe('sub-ws');
      expect(f.resourceGroup).toBe('rg-logs');
    }
  });

  it('asks Resource Graph about the workspace once for the whole run, however many findings and rules', async () => {
    const lookups: string[] = [];
    const ctx = fakeCtx(async () => rows, [], {
      id: WORKSPACE_CUSTOMER_ID,
      queryARG: async (kql) => { lookups.push(kql); return [workspaceRow()]; },
    });
    await drain([rule, baseRule({ id: 'second-rule', logsQuery: { kql: 'Y', timeWindowDays: 30 } })], ctx);

    expect(lookups).toHaveLength(1);
    expect(lookups[0]).toContain(WORKSPACE_CUSTOMER_ID);
  });

  it('makes no lookup when no rule returns a row', async () => {
    const ctx = fakeCtx(async () => [], [], { id: WORKSPACE_CUSTOMER_ID, queryARG: async () => { throw new Error('no lookup expected'); } });
    const events = await drain([rule], ctx);

    expect(findingsOf(events)).toEqual([]);
    expect(events).toEqual([{ kind: 'outcome', outcome: { ruleId: rule.id, status: 'success', findingCount: 0 } }]);
  });

  it('makes no lookup when no workspace is configured, and the finding is unplaceable with no subscription', async () => {
    const ctx = fakeCtx(async () => rows, [], { queryARG: async () => { throw new Error('no lookup expected'); } });
    const findings = findingsOf(await drain([rule], ctx));

    expect(findings.map(f => [f.placement, f.subscriptionId])).toEqual([['unplaceable', ''], ['unplaceable', '']]);
  });

  it('is unplaceable when Resource Graph does not know the workspace, and the rule still succeeds', async () => {
    const logs: CapturedLog[] = [];
    const ctx = fakeCtx(async () => rows, logs, { id: WORKSPACE_CUSTOMER_ID, queryARG: async () => [] });
    const events = await drain([rule], ctx);

    expect(findingsOf(events).map(f => [f.placement, f.subscriptionId, f.resourceGroup])).toEqual([
      ['unplaceable', '', undefined], ['unplaceable', '', undefined],
    ]);
    expect(events.at(-1)).toEqual({ kind: 'outcome', outcome: { ruleId: rule.id, status: 'success', findingCount: 2 } });
    expect(logs.some(l => l.fields?.operation === 'workspace-placement' && l.fields.level === 'warn')).toBe(true);
  });

  it('is unplaceable, with a warning and the rule still successful, when the lookup throws', async () => {
    const logs: CapturedLog[] = [];
    const ctx = fakeCtx(async () => rows, logs, { id: WORKSPACE_CUSTOMER_ID, queryARG: async () => { throw new Error('arg is down'); } });
    const events = await drain([rule], ctx);

    expect(findingsOf(events).every(f => f.placement === 'unplaceable' && f.subscriptionId === '')).toBe(true);
    expect(events.at(-1)).toEqual({ kind: 'outcome', outcome: { ruleId: rule.id, status: 'success', findingCount: 2 } });
    expect(logs.find(l => l.fields?.operation === 'workspace-placement')?.fields?.level).toBe('warn');
  });

  it('trusts only the row whose customer id is the configured one', async () => {
    const stranger = workspaceRow({ subscriptionId: 'sub-other', customerId: '11111111-0000-0000-0000-000000000000' });
    const ctx = fakeCtx(async () => rows, [], { id: WORKSPACE_CUSTOMER_ID, queryARG: async () => [stranger] });
    const findings = findingsOf(await drain([rule], ctx));

    expect(findings.map(f => [f.placement, f.subscriptionId])).toEqual([['unplaceable', ''], ['unplaceable', '']]);
  });

  it('matches the customer id without regard to case', async () => {
    const ctx = fakeCtx(async () => rows, [], {
      id: WORKSPACE_CUSTOMER_ID,
      queryARG: async () => [workspaceRow({ customerId: WORKSPACE_CUSTOMER_ID.toUpperCase() })],
    });
    expect(findingsOf(await drain([rule], ctx)).map(f => f.subscriptionId)).toEqual(['sub-ws', 'sub-ws']);
  });
});
