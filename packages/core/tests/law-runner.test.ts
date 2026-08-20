/**
 * Spec 036 — Log Analytics rule authoring.
 *
 * runLawRules() is the Log Analytics-backend counterpart to runner.ts's runRules() and
 * graph-runner.ts's runGraphRules(): same RuleRunEvent/RuleExecutionStatus contract
 * (success/failed/capped/invalid), but LAW-shaped internals (ctx.queryLogs() instead of
 * queryARG()/graphGet(), no ARM id or Graph object id — findings are 'activity' kind, keyed by an
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

function fakeCtx(queryLogs: FakeQueryLogs, logs: CapturedLog[] = []): TenantContext {
  return {
    tenantId: 'test-tenant',
    subscriptionIds: ['sub-1'],
    credential: {} as TokenCredential,
    log: (message, fields) => { logs.push({ message, fields }); },
    queryARG: async () => { throw new Error('runLawRules must never call queryARG'); },
    graphGet: async () => { throw new Error('runLawRules must never call graphGet'); },
    queryLogs: queryLogs as unknown as TenantContext['queryLogs'],
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
    expect(findings[0].finding.subscriptionId).toBe('sub-1');
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

  it('skips a disabled rule entirely — no query, no events', async () => {
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
    // rule-b's finding must still have been yielded — one bad rule must not swallow another's results.
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
});
