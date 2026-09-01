/**
 * Spec 004 — a category's coverage: 'partial' must surface as a run-level status: 'partial', even
 * though await runCategoryScan() returns normally (no thrown error) in that case. Before this fix,
 * await executeTarget()'s status formula only looked at thrown exceptions, so a rule that failed or
 * returned a capped result inside an otherwise-successful scan produced a silent 'success' run.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { TokenCredential } from '@azure/identity';
import type { TenantContext } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { rules as rulesTable } from '@/lib/db/tables';
import { executeTarget } from '@/lib/run-executor';
import { resetDb, clearRules } from '../helpers/db';
import { argRow, TEST_SUB_A } from '../helpers/fake-azure';

const RULE_OK = 'test-rule-ok';
const RULE_FAIL = 'test-rule-fail';
const MARKER_OK = '// marker-ok';
const MARKER_FAIL = '// marker-fail';

async function insertRule(id: string, marker: string): Promise<void> {
  await execRun(db.insert(rulesTable).values({
    id,
    name: id,
    description: 'test rule',
    category: 'security',
    severity: 'medium',
    enabled: true,
    scope: JSON.stringify({ level: 'subscription' }),
    resourceTypes: JSON.stringify([]),
    conditions: JSON.stringify([]),
    rawKql: `resources | where type == "microsoft.compute/virtualmachines" ${marker}`,
    type: 'custom',
  }));
}

type QueryBehavior = Record<string, { rows?: Record<string, unknown>[]; failWith?: Error }>;

function makeCtx(behavior: QueryBehavior): TenantContext {
  return {
    tenantId: 'test-tenant',
    subscriptionIds: [TEST_SUB_A],
    credential: {} as TokenCredential,
    log: () => {},
    async graphGet<TValue = Record<string, unknown>>(): Promise<TValue[]> {
      throw new Error('test ctx: graphGet should not be called in this ARG-only suite');
    },
    async queryLogs<TRow = Record<string, unknown>>(): Promise<TRow[]> {
      throw new Error('test ctx: queryLogs should not be called in this ARG-only suite');
    },
    async queryARG<TRow = Record<string, unknown>>(kql: string): Promise<TRow[]> {
      const marker = Object.keys(behavior).find(m => kql.includes(m));
      if (!marker) throw new Error(`test ctx: no behavior registered for query: ${kql}`);
      const b = behavior[marker]!;
      if (b.failWith) throw b.failWith;
      return (b.rows ?? []) as TRow[];
    },
  };
}

describe('await executeTarget() partial coverage (spec 004)', () => {
  beforeEach(async () => {
    await resetDb();
    await clearRules();
    await insertRule(RULE_OK, MARKER_OK);
    await insertRule(RULE_FAIL, MARKER_FAIL);
  });

  it('maps a category coverage of partial to a run-level status of partial, without any thrown error', async () => {
    const run = await executeTarget(
      { targetType: 'categories', targetValues: ['security'] },
      {
        triggeredBy: 'manual',
        ctx: makeCtx({
          [MARKER_OK]: { rows: [argRow({ name: 'vm-ok' })] },
          [MARKER_FAIL]: { failWith: new Error('429 Too Many Requests') },
        }),
      },
    );

    expect(run.status).toBe('partial');
    expect(run.error).toMatch(/security/);
  });

  it('never leaks a raw thrown error to run.error — only a client-safe summary reaches the UI', async () => {
    // Malformed rule data makes await loadRules() throw synchronously inside runCategoryScan, reproducing
    // a genuine unexpected-exception path — distinct from the coverage 'failed'/'capped' outcome path
    // covered above, which never throws at all. Run History renders run.error directly (spec 004), so
    // this asserts the fix in run-executor.ts: raw error text is logged server-side, never returned.
    await execRun(db.insert(rulesTable).values({
      id: 'test-rule-malformed',
      name: 'malformed',
      description: 'test rule',
      category: 'security',
      severity: 'medium',
      enabled: true,
      scope: JSON.stringify({ level: 'subscription' }),
      resourceTypes: JSON.stringify([]),
      conditions: 'not-valid-json',
      type: 'custom',
    }));

    const run = await executeTarget(
      { targetType: 'categories', targetValues: ['security'] },
      {
        triggeredBy: 'manual',
        ctx: makeCtx({ [MARKER_OK]: { rows: [] }, [MARKER_FAIL]: { rows: [] } }),
      },
    );

    expect(run.status).toBe('error');
    expect(run.error).not.toBeNull();
    expect(run.error).not.toMatch(/JSON/i);
    expect(run.error).not.toMatch(/SyntaxError/i);
    expect(run.error).toMatch(/check the RuleBeat server logs/i);
  });

  it('regression guard: a fully clean run across all rules still reports success', async () => {
    const run = await executeTarget(
      { targetType: 'categories', targetValues: ['security'] },
      {
        triggeredBy: 'manual',
        ctx: makeCtx({
          [MARKER_OK]: { rows: [argRow({ name: 'vm-ok' })] },
          [MARKER_FAIL]: { rows: [] },
        }),
      },
    );

    expect(run.status).toBe('success');
    expect(run.error).toBeNull();
  });
});
