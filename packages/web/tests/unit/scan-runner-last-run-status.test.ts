/**
 * Spec 030 — runCategoryScan() must persist each rule's own last-run outcome, so a later "zero
 * findings" can be told apart from "this rule has never successfully run" (an always-erroring rule
 * would otherwise read identically to an always-passing one). See setRulesLastRunStatus() in
 * lib/rules.ts and its call site in lib/scan-runner.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { TokenCredential } from '@azure/identity';
import type { TenantContext } from '@rulebeat/core';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { rules as rulesTable } from '@/lib/db/schema';
import { getCategory } from '@/lib/db/categories';
import { runCategoryScan } from '@/lib/scan-runner';
import { loadRules } from '@/lib/rules';
import { resetDb, clearRules } from '../helpers/db';
import { TEST_SUB_A } from '../helpers/fake-azure';

const RULE_OK = 'test-rule-ok';
const RULE_FAILS = 'test-rule-fails';
const RULE_OUT_OF_SCOPE = 'test-rule-out-of-scope';
const MARKER_OK = '// marker-ok';
const MARKER_FAIL = '// marker-fail';

function insertRule(id: string, marker: string): void {
  db.insert(rulesTable).values({
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
  }).run();
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

function lastRunOf(id: string): { status: string | undefined; at: string | undefined } {
  const rule = loadRules().find(r => r.id === id);
  expect(rule, `expected rule ${id} to exist`).toBeTruthy();
  return { status: rule!.lastRunStatus, at: rule!.lastRunAt };
}

describe('runCategoryScan persists each rule\'s own last-run outcome (spec 030)', () => {
  beforeEach(() => {
    resetDb();
    clearRules();
    insertRule(RULE_OK, MARKER_OK);
    insertRule(RULE_FAILS, MARKER_FAIL);
    insertRule(RULE_OUT_OF_SCOPE, MARKER_OK);
    // Gives this rule real prior history, so the "untouched" assertion below proves the scan left
    // it alone rather than merely proving a null stayed null.
    db.update(rulesTable)
      .set({ lastRunStatus: 'success', lastRunAt: '2026-01-01T00:00:00.000Z' })
      .where(eq(rulesTable.id, RULE_OUT_OF_SCOPE))
      .run();
  });

  it('a rule whose query throws is stamped "failed"; one that returns cleanly is stamped "success" — both at this scan\'s finish time', async () => {
    const category = getCategory('security')!;
    const outcome = await runCategoryScan(category, {
      ctx: makeCtx({
        [MARKER_OK]: { rows: [] },
        [MARKER_FAIL]: { failWith: new Error('429 Too Many Requests') },
      }),
      ruleIds: [RULE_OK, RULE_FAILS],
    });

    expect(lastRunOf(RULE_OK)).toEqual({ status: 'success', at: outcome.summary.finishedAt });
    expect(lastRunOf(RULE_FAILS)).toEqual({ status: 'failed', at: outcome.summary.finishedAt });
  });

  it('a rule excluded from this scan by opts.ruleIds keeps its prior last-run status untouched', async () => {
    const category = getCategory('security')!;
    await runCategoryScan(category, {
      ctx: makeCtx({ [MARKER_OK]: { rows: [] } }),
      ruleIds: [RULE_OK], // RULE_OUT_OF_SCOPE is deliberately not included
    });

    expect(lastRunOf(RULE_OUT_OF_SCOPE)).toEqual({ status: 'success', at: '2026-01-01T00:00:00.000Z' });
  });
});
