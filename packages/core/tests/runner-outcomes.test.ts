/**
 * Spec 004 — scan lifecycle correctness.
 *
 * runRules() now yields a per-rule RuleExecutionOutcome alongside its findings, on the same
 * generator, rather than silently swallowing a query failure into a log line. The contract this
 * suite pins: only 'success' may be read by a caller as "safe to resolve this rule's prior
 * findings" — 'failed' (the query threw) and 'capped' (a top-level take/top, or Resource Graph
 * itself reporting a truncated result) must both be indistinguishable from each other in that
 * respect, even though their *cause* differs.
 */
import { describe, expect, it } from 'vitest';
import type { TokenCredential } from '@azure/identity';
import { runRules } from '../src/engine/runner.js';
import { ResourceGraphTruncatedError } from '../src/clients/resource-graph.js';
import type { Rule, RuleRunEvent, VisualQuery } from '../src/engine/types.js';
import type { Finding, LogFields, QueryScope, TenantContext } from '../src/types.js';

interface CapturedLog { message: string; fields?: LogFields }

function baseRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'test-rule',
    name: 'Test rule',
    description: 'desc',
    category: 'reliability',
    severity: 'medium',
    enabled: true,
    type: 'custom',
    scope: { level: 'subscription' },
    resourceTypes: [],
    conditions: [],
    rawKql: 'resources | where type == "microsoft.compute/virtualmachines"',
    ...overrides,
  };
}

function argRow(id: string): Record<string, unknown> {
  return {
    id,
    name: id.split('/').pop(),
    type: 'microsoft.compute/virtualmachines',
    location: 'eastus',
    resourceGroup: 'rg1',
    subscriptionId: 'sub-1',
  };
}

function fakeCtx(
  queryARG: (kql: string, scope?: QueryScope) => Promise<Record<string, unknown>[]>,
  logs: CapturedLog[] = [],
): TenantContext {
  return {
    tenantId: 'test-tenant',
    subscriptionIds: ['sub-1'],
    credential: {} as TokenCredential,
    log: (message, fields) => { logs.push({ message, fields }); },
    queryARG,
  };
}

async function drain(rule: Rule, ctx: TenantContext): Promise<RuleRunEvent<Finding>[]> {
  const out: RuleRunEvent<Finding>[] = [];
  for await (const event of runRules([rule], ctx)) out.push(event);
  return out;
}

describe('runRules() per-rule outcomes (spec 004)', () => {
  it('yields a success outcome with the finding count when the query returns rows cleanly', async () => {
    const rule = baseRule();
    const rows = [argRow('/subscriptions/sub-1/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/vm1')];
    const logs: CapturedLog[] = [];
    const ctx = fakeCtx(async () => rows, logs);

    const events = await drain(rule, ctx);
    const findingEvents = events.filter(e => e.kind === 'finding');
    const outcomeEvents = events.filter(e => e.kind === 'outcome');

    expect(findingEvents).toHaveLength(1);
    expect(outcomeEvents).toEqual([
      { kind: 'outcome', outcome: { ruleId: 'test-rule', status: 'success', findingCount: 1 } },
    ]);

    // spec 006: one rule-start line, then exactly one rule-outcome line carrying the same shape
    // the outcome event itself was yielded with.
    expect(logs.map(l => l.fields?.operation)).toEqual(['rule-start', 'rule-outcome']);
    const outcomeLog = logs[1]!;
    expect(outcomeLog.fields).toMatchObject({
      ruleId: 'test-rule',
      category: 'reliability',
      status: 'success',
      findingCount: 1,
      level: 'info',
    });
    expect(outcomeLog.fields?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('yields a failed outcome, not a silent empty result, when the ARG query throws', async () => {
    const rule = baseRule();
    const logs: CapturedLog[] = [];
    const ctx = fakeCtx(async () => { throw new Error('429 Too Many Requests'); }, logs);

    const events = await drain(rule, ctx);

    expect(events).toEqual([
      { kind: 'outcome', outcome: { ruleId: 'test-rule', status: 'failed', findingCount: 0 } },
    ]);

    const outcomeLog = logs.find(l => l.fields?.operation === 'rule-outcome');
    expect(outcomeLog?.fields).toMatchObject({ ruleId: 'test-rule', status: 'failed', findingCount: 0, level: 'error' });
    expect(outcomeLog?.message).toContain('429 Too Many Requests');
  });

  it('yields a capped outcome when the compiled query has a top-level take/top', async () => {
    const rule = baseRule({ rawKql: 'resources\n| where type == "microsoft.compute/virtualmachines"\n| take 5' });
    const rows = [argRow('/subscriptions/sub-1/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/vm1')];
    const logs: CapturedLog[] = [];
    const ctx = fakeCtx(async () => rows, logs);

    const events = await drain(rule, ctx);
    const findingEvents = events.filter(e => e.kind === 'finding');
    const outcomeEvents = events.filter(e => e.kind === 'outcome');

    // A capped rule still reports whatever it found — the finding count is real, just not proven
    // to be the *complete* set, which is exactly why 'capped' must not resolve prior findings.
    expect(findingEvents).toHaveLength(1);
    expect(outcomeEvents).toEqual([
      { kind: 'outcome', outcome: { ruleId: 'test-rule', status: 'capped', findingCount: 1 } },
    ]);

    const outcomeLog = logs.find(l => l.fields?.operation === 'rule-outcome');
    expect(outcomeLog?.fields).toMatchObject({ status: 'capped', findingCount: 1, level: 'info' });
  });

  it('yields a capped outcome, not failed, when Resource Graph reports the result truncated', async () => {
    const rule = baseRule();
    const logs: CapturedLog[] = [];
    const ctx = fakeCtx(async () => { throw new ResourceGraphTruncatedError(1000); }, logs);

    const events = await drain(rule, ctx);

    expect(events).toEqual([
      { kind: 'outcome', outcome: { ruleId: 'test-rule', status: 'capped', findingCount: 0 } },
    ]);

    const outcomeLog = logs.find(l => l.fields?.operation === 'rule-outcome');
    expect(outcomeLog?.fields).toMatchObject({ status: 'capped', findingCount: 0, level: 'info' });
  });
});

describe('runRules() Applies-to population query (spec 031)', () => {
  // A minimal but real filter stage — runPopulationQuery() runs unconditionally whenever
  // rule.appliesTo is set, regardless of what it contains, so the exact condition doesn't matter
  // to these tests; what matters is that a rule with appliesTo triggers a second queryARG() call.
  const appliesTo: VisualQuery = {
    stages: [{
      id: 'f1',
      type: 'filter',
      groups: [{ id: 'g1', conditions: [{ id: 'c1', field: 'name', operator: 'exists' }] }],
    }],
  };

  it('flips an otherwise-successful outcome to failed when the population query throws, keeping the real finding count', async () => {
    const rule = baseRule({ appliesTo });
    const rows = [argRow('/subscriptions/sub-1/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/vm1')];
    const logs: CapturedLog[] = [];
    let call = 0;
    const ctx = fakeCtx(async () => {
      call++;
      if (call === 1) return rows;
      throw new Error('population query: 429 Too Many Requests');
    }, logs);

    const events = await drain(rule, ctx);
    const findingEvents = events.filter(e => e.kind === 'finding');
    const outcomeEvents = events.filter(e => e.kind === 'outcome');

    // The violation query alone succeeded (1 finding) — only the population query's own failure
    // makes the combined outcome 'failed'. findingCount stays real; it's derived purely from the
    // violation query and is never zeroed out by a population-side problem.
    expect(findingEvents).toHaveLength(1);
    expect(outcomeEvents).toEqual([
      { kind: 'outcome', outcome: { ruleId: 'test-rule', status: 'failed', findingCount: 1 } },
    ]);

    const outcomeLog = logs.find(l => l.fields?.operation === 'rule-outcome');
    expect(outcomeLog?.fields).toMatchObject({ status: 'failed', findingCount: 1, level: 'error' });
    const populationLog = logs.find(l => l.fields?.operation === 'rule-population-outcome');
    expect(populationLog?.fields).toMatchObject({ level: 'error' });
  });

  it('flips an otherwise-successful outcome to capped when the population query is truncated, with no populationCount to show for it', async () => {
    const rule = baseRule({ appliesTo });
    const rows = [argRow('/subscriptions/sub-1/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/vm1')];
    let call = 0;
    const ctx = fakeCtx(async () => {
      call++;
      if (call === 1) return rows;
      throw new ResourceGraphTruncatedError(1000);
    });

    const events = await drain(rule, ctx);
    const outcomeEvents = events.filter(e => e.kind === 'outcome');

    expect(outcomeEvents).toEqual([
      { kind: 'outcome', outcome: { ruleId: 'test-rule', status: 'capped', findingCount: 1 } },
    ]);
    // A truncated population query has no trustworthy count — a caller can't say "3 of N" without
    // a real N, so populationCount must stay absent rather than carry a partial number.
    expect(outcomeEvents[0]!.outcome).not.toHaveProperty('populationCount');
  });

  it('carries populationCount in the outcome when both the violation and population queries succeed', async () => {
    const rule = baseRule({ appliesTo });
    const rows = [argRow('/subscriptions/sub-1/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/vm1')];
    let call = 0;
    const ctx = fakeCtx(async () => {
      call++;
      return call === 1 ? rows : [{ Count: 40 }];
    });

    const events = await drain(rule, ctx);

    expect(events.filter(e => e.kind === 'outcome')).toEqual([
      { kind: 'outcome', outcome: { ruleId: 'test-rule', status: 'success', findingCount: 1, populationCount: 40 } },
    ]);
  });

  it('skips the population query entirely when the violation query fails outright, since failed already outranks every population outcome', async () => {
    const rule = baseRule({ appliesTo });
    let calls = 0;
    const ctx = fakeCtx(async () => { calls++; throw new Error('violation query exploded'); });

    const events = await drain(rule, ctx);

    expect(calls).toBe(1);
    expect(events).toEqual([
      { kind: 'outcome', outcome: { ruleId: 'test-rule', status: 'failed', findingCount: 0 } },
    ]);
  });

  it('still runs the population query when the violation query is merely truncated, and a failed population query still wins out over capped', async () => {
    const rule = baseRule({ appliesTo });
    let call = 0;
    const ctx = fakeCtx(async () => {
      call++;
      if (call === 1) throw new ResourceGraphTruncatedError(1000);
      throw new Error('population query failed too');
    });

    const events = await drain(rule, ctx);

    expect(call).toBe(2);
    expect(events).toEqual([
      { kind: 'outcome', outcome: { ruleId: 'test-rule', status: 'failed', findingCount: 0 } },
    ]);
  });
});

describe('runRules() identity-less rows (spec 005)', () => {
  it('skips rows with no id and reports invalid, not success, when some rows lack identity', async () => {
    const rule = baseRule();
    const rows = [
      argRow('/subscriptions/sub-1/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/vm1'),
      argRow('/subscriptions/sub-1/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/vm2'),
      { ...argRow(''), id: undefined },
    ];
    const ctx = fakeCtx(async () => rows);

    const events = await drain(rule, ctx);
    const findingEvents = events.filter(e => e.kind === 'finding');
    const outcomeEvents = events.filter(e => e.kind === 'outcome');

    // Only the 2 rows with a real id become findings — this is the case that fails without the
    // fix: today all 3 rows (including the id-less one) would be counted and 'success' returned.
    expect(findingEvents).toHaveLength(2);
    expect(outcomeEvents).toEqual([
      { kind: 'outcome', outcome: { ruleId: 'test-rule', status: 'invalid', findingCount: 2 } },
    ]);
  });

  it('reports invalid with zero findings when every row lacks an id', async () => {
    const rule = baseRule();
    const rows = [{ name: 'orphan-1' }, { name: 'orphan-2' }];
    const ctx = fakeCtx(async () => rows);

    const events = await drain(rule, ctx);

    // This is the sharpest form of the bug: every row collapses onto resourceId '' today, so the
    // rule reports 'success' with findingCount: 1 (one bogus finding) instead of catching it.
    expect(events).toEqual([
      { kind: 'outcome', outcome: { ruleId: 'test-rule', status: 'invalid', findingCount: 0 } },
    ]);
  });

  it('treats an empty-string id and a whitespace-only id as invalid, not merely an absent property', async () => {
    const rule = baseRule();
    const rows = [
      { ...argRow('vm-with-id'), id: 'vm-with-id' },
      { ...argRow(''), id: '' },
      { ...argRow(''), id: '   ' },
    ];
    const ctx = fakeCtx(async () => rows);

    const events = await drain(rule, ctx);
    const findingEvents = events.filter(e => e.kind === 'finding');
    const outcomeEvents = events.filter(e => e.kind === 'outcome');

    expect(findingEvents).toHaveLength(1);
    expect(outcomeEvents).toEqual([
      { kind: 'outcome', outcome: { ruleId: 'test-rule', status: 'invalid', findingCount: 1 } },
    ]);
  });

  it('reports invalid, not capped, when a top-level take AND an identity-less row both apply', async () => {
    const rule = baseRule({ rawKql: 'resources\n| where type == "microsoft.compute/virtualmachines"\n| take 5' });
    const rows = [
      argRow('/subscriptions/sub-1/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/vm1'),
      { name: 'orphan' },
    ];
    const ctx = fakeCtx(async () => rows);

    const events = await drain(rule, ctx);

    // Pins the stated precedence: 'invalid' wins over 'capped' when both would otherwise apply.
    expect(events.filter(e => e.kind === 'outcome')).toEqual([
      { kind: 'outcome', outcome: { ruleId: 'test-rule', status: 'invalid', findingCount: 1 } },
    ]);
  });

  it('catches an identity-less row beyond the first few, not just the leading rows', async () => {
    // The save-time/validate-kql probe only samples 5 rows and can't see this by construction —
    // this is the residual case that only runner.ts's own per-row filtering catches, at scan time.
    const rule = baseRule();
    const rows = Array.from({ length: 10 }, (_, i) =>
      i === 5
        ? { name: 'orphan-row-6' }
        : argRow(`/subscriptions/sub-1/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/vm${i}`),
    );
    const ctx = fakeCtx(async () => rows);

    const events = await drain(rule, ctx);
    const findingEvents = events.filter(e => e.kind === 'finding');
    const outcomeEvents = events.filter(e => e.kind === 'outcome');

    expect(findingEvents).toHaveLength(9);
    expect(outcomeEvents).toEqual([
      { kind: 'outcome', outcome: { ruleId: 'test-rule', status: 'invalid', findingCount: 9 } },
    ]);
  });
});

describe('runRules() structured logging (spec 006)', () => {
  it('unwraps a real Azure SDK error shape in the outcome log message instead of a generic wrapper', async () => {
    const rule = baseRule();
    const logs: CapturedLog[] = [];
    const azureErr = Object.assign(new Error('Please provide below info when asking for support...'), {
      statusCode: 403,
      details: [{ message: 'no permission' }],
    });
    const ctx = fakeCtx(async () => { throw azureErr; }, logs);

    await drain(rule, ctx);

    const outcomeLog = logs.find(l => l.fields?.operation === 'rule-outcome');
    expect(outcomeLog?.message).toContain('no permission');
    expect(outcomeLog?.message).not.toContain('Please provide below info');
    expect(outcomeLog?.fields).toMatchObject({ status: 'failed', level: 'error' });
  });

  it('logs a warn-level line when identity enrichment fails, without failing the rule itself', async () => {
    const rule = baseRule();
    const logs: CapturedLog[] = [];
    // Missing type/location/resourceGroup/subscriptionId triggers the enrichment follow-up query.
    const partialRow = {
      id: '/subscriptions/sub-1/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/vm1',
      name: 'vm1',
    };
    let call = 0;
    const ctx = fakeCtx(async () => {
      call++;
      if (call === 1) return [partialRow];
      throw new Error('enrichment query failed');
    }, logs);

    const events = await drain(rule, ctx);

    const warnLog = logs.find(l => l.fields?.operation === 'enrichment-failed');
    expect(warnLog?.fields).toMatchObject({ ruleId: 'test-rule', category: 'reliability', level: 'warn' });
    expect(warnLog?.message).toContain('enrichment query failed');

    // Enrichment failing is not the rule failing — the rule still completes and its own outcome
    // log line still fires, separately from the warn line above.
    expect(events.filter(e => e.kind === 'outcome')).toEqual([
      { kind: 'outcome', outcome: { ruleId: 'test-rule', status: 'success', findingCount: 1 } },
    ]);
    const outcomeLog = logs.find(l => l.fields?.operation === 'rule-outcome');
    expect(outcomeLog?.fields).toMatchObject({ status: 'success', level: 'info' });
  });

  it('fires rule-start before running each rule, across multiple rules in one scan', async () => {
    const ruleA = baseRule({ id: 'rule-a', name: 'Rule A' });
    const ruleB = baseRule({ id: 'rule-b', name: 'Rule B' });
    const logs: CapturedLog[] = [];
    const ctx = fakeCtx(async () => [], logs);

    const out: RuleRunEvent<Finding>[] = [];
    for await (const event of runRules([ruleA, ruleB], ctx)) out.push(event);

    expect(logs.map(l => `${l.fields?.operation}:${l.fields?.ruleId}`)).toEqual([
      'rule-start:rule-a',
      'rule-outcome:rule-a',
      'rule-start:rule-b',
      'rule-outcome:rule-b',
    ]);
  });
});
