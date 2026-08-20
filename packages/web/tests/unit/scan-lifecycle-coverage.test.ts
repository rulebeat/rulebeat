/**
 * Spec 004 — scan lifecycle correctness, end to end through runCategoryScan().
 *
 * The bug this spec fixes: a rule whose ARG query throws (or is capped/truncated) used to be
 * indistinguishable from a rule that legitimately found nothing — syncScanFindings() would resolve
 * ("fix") every one of that rule's previously-active findings. The actual fix lives in scan-runner.ts
 * narrowing `ranRuleIds` to only rules whose outcome was 'success' (see runner-outcomes.test.ts for
 * the outcome-classification unit tests); this suite proves that narrowing reaches all the way
 * through to the findings table and the scan's own coverage/incompleteRules fields, for a category
 * with a genuine mix of a failing rule and a succeeding one in the same scan.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { TokenCredential } from '@azure/identity';
import { computeFingerprint, type TenantContext } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { rules as rulesTable } from '@/lib/db/schema';
import { getCategory } from '@/lib/db/categories';
import { runCategoryScan } from '@/lib/scan-runner';
import { listFindings } from '@/lib/db/findings';
import { resetDb, clearRules } from '../helpers/db';
import { argRow, TEST_SUB_A } from '../helpers/fake-azure';

const RULE_OK = 'test-rule-ok';
const RULE_FAIL = 'test-rule-fail';
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

/** A minimal TenantContext whose queryARG branches on which rule's marker appears in the KQL —
 *  fakeTenantContext's `failWith` is all-or-nothing, but this suite needs one rule in the same
 *  scan to fail while another succeeds. */
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

function securityCategory() {
  const category = getCategory('security');
  expect(category, "expected the seeded 'security' category to exist").toBeTruthy();
  return category!;
}

describe('scan lifecycle coverage (spec 004)', () => {
  beforeEach(() => {
    resetDb();
    // The built-in APRL pack seeds enabled rules into 'security' too — clear the table so this
    // suite's fake ctx only ever has to answer for the two rules it explicitly wires up.
    clearRules();
    insertRule(RULE_OK, MARKER_OK);
    insertRule(RULE_FAIL, MARKER_FAIL);
  });

  it('a failed rule leaves its prior active finding untouched, while a still-succeeding rule keeps resolving', async () => {
    const category = securityCategory();
    const okRow = argRow({ name: 'vm-ok' });
    const failRow = argRow({ name: 'vm-fail' });
    const okFingerprint = computeFingerprint(RULE_OK, okRow.id as string);
    const failFingerprint = computeFingerprint(RULE_FAIL, failRow.id as string);

    // Scan 1: both rules succeed, both findings created active.
    await runCategoryScan(category, {
      ctx: makeCtx({ [MARKER_OK]: { rows: [okRow] }, [MARKER_FAIL]: { rows: [failRow] } }),
      ruleIds: [RULE_OK, RULE_FAIL],
    });

    let findings = listFindings();
    expect(findings.find(f => f.fingerprint === okFingerprint)?.status).toBe('active');
    expect(findings.find(f => f.fingerprint === failFingerprint)?.status).toBe('active');

    // Scan 2: rule-ok's resource is genuinely gone; rule-fail's query throws (e.g. a 429).
    const outcome = await runCategoryScan(category, {
      ctx: makeCtx({
        [MARKER_OK]: { rows: [] },
        [MARKER_FAIL]: { failWith: new Error('429 Too Many Requests') },
      }),
      ruleIds: [RULE_OK, RULE_FAIL],
    });

    expect(outcome.summary.coverage).toBe('partial');
    expect(outcome.summary.incompleteRules).toEqual([
      { ruleId: RULE_FAIL, ruleName: RULE_FAIL, status: 'failed' },
    ]);

    findings = listFindings();
    // rule-ok genuinely found nothing this time — resolving it is correct, not a regression.
    expect(findings.find(f => f.fingerprint === okFingerprint)?.status).toBe('fixed');
    // rule-fail's query threw — its prior finding must survive, not be silently marked fixed.
    expect(findings.find(f => f.fingerprint === failFingerprint)?.status).toBe('active');
  });

  it('a capped rule (top-level take) also leaves its prior active finding untouched', async () => {
    const category = securityCategory();
    // Overwrite rule-fail with a query that has a top-level `take` — capped, not failed.
    db.delete(rulesTable).run();
    insertRule(RULE_OK, MARKER_OK);
    db.insert(rulesTable).values({
      id: RULE_FAIL,
      name: RULE_FAIL,
      description: 'test rule',
      category: 'security',
      severity: 'medium',
      enabled: true,
      scope: JSON.stringify({ level: 'subscription' }),
      resourceTypes: JSON.stringify([]),
      conditions: JSON.stringify([]),
      rawKql: `resources | where type == "microsoft.compute/virtualmachines" ${MARKER_FAIL} | take 5`,
      type: 'custom',
    }).run();

    const failRow = argRow({ name: 'vm-capped' });
    const failFingerprint = computeFingerprint(RULE_FAIL, failRow.id as string);

    await runCategoryScan(category, {
      ctx: makeCtx({ [MARKER_OK]: { rows: [] }, [MARKER_FAIL]: { rows: [failRow] } }),
      ruleIds: [RULE_OK, RULE_FAIL],
    });
    expect(listFindings().find(f => f.fingerprint === failFingerprint)?.status).toBe('active');

    // Scan 2: the capped rule returns no rows this time — a real result set could easily still
    // contain the same resource, just past the take-5 cutoff, so this must not resolve it either.
    const outcome = await runCategoryScan(category, {
      ctx: makeCtx({ [MARKER_OK]: { rows: [] }, [MARKER_FAIL]: { rows: [] } }),
      ruleIds: [RULE_OK, RULE_FAIL],
    });

    expect(outcome.summary.coverage).toBe('partial');
    expect(outcome.summary.incompleteRules).toEqual([
      { ruleId: RULE_FAIL, ruleName: RULE_FAIL, status: 'capped' },
    ]);
    expect(listFindings().find(f => f.fingerprint === failFingerprint)?.status).toBe('active');
  });

  it('a rule returning identity-less rows (spec 005) leaves its prior active finding untouched and reports invalid', async () => {
    const category = securityCategory();
    const okRow = argRow({ name: 'vm-ok' });
    const failRow = argRow({ name: 'vm-fail' });
    const okFingerprint = computeFingerprint(RULE_OK, okRow.id as string);
    const failFingerprint = computeFingerprint(RULE_FAIL, failRow.id as string);

    // Scan 1: both rules succeed cleanly, both findings created active.
    await runCategoryScan(category, {
      ctx: makeCtx({ [MARKER_OK]: { rows: [okRow] }, [MARKER_FAIL]: { rows: [failRow] } }),
      ruleIds: [RULE_OK, RULE_FAIL],
    });
    expect(listFindings().find(f => f.fingerprint === failFingerprint)?.status).toBe('active');

    // Scan 2: rule-fail's query still runs fine but now returns a mix of a real row and one with no
    // usable id — a bad projection, not an ARG failure. Its result can't be trusted as exhaustive
    // (the identity-less row could just as easily have been the one resource that matched before),
    // so the prior finding must survive exactly like the failed/capped cases above.
    const outcome = await runCategoryScan(category, {
      ctx: makeCtx({
        [MARKER_OK]: { rows: [] },
        [MARKER_FAIL]: { rows: [failRow, { name: 'no-id-row', type: 'microsoft.compute/virtualmachines' }] },
      }),
      ruleIds: [RULE_OK, RULE_FAIL],
    });

    expect(outcome.summary.coverage).toBe('partial');
    expect(outcome.summary.incompleteRules).toEqual([
      { ruleId: RULE_FAIL, ruleName: RULE_FAIL, status: 'invalid' },
    ]);

    const findings = listFindings();
    expect(findings.find(f => f.fingerprint === okFingerprint)?.status).toBe('fixed');
    expect(findings.find(f => f.fingerprint === failFingerprint)?.status).toBe('active');
  });

  it('regression guard: when every rule succeeds, an unseen finding still resolves', async () => {
    const category = securityCategory();
    const row = argRow({ name: 'vm-both-ok' });
    const fingerprint = computeFingerprint(RULE_OK, row.id as string);

    await runCategoryScan(category, {
      ctx: makeCtx({ [MARKER_OK]: { rows: [row] }, [MARKER_FAIL]: { rows: [] } }),
      ruleIds: [RULE_OK, RULE_FAIL],
    });
    expect(listFindings().find(f => f.fingerprint === fingerprint)?.status).toBe('active');

    const outcome = await runCategoryScan(category, {
      ctx: makeCtx({ [MARKER_OK]: { rows: [] }, [MARKER_FAIL]: { rows: [] } }),
      ruleIds: [RULE_OK, RULE_FAIL],
    });

    expect(outcome.summary.coverage).toBe('complete');
    expect(outcome.summary.incompleteRules).toEqual([]);
    expect(listFindings().find(f => f.fingerprint === fingerprint)?.status).toBe('fixed');
  });
});
