/**
 * Spec 036 — await runCategoryScan()'s queryBackend partitioning (spec 029) extends to a third backend,
 * 'log-analytics', with no special-casing: a log-analytics rule filed under 'identity' runs through
 * runLawRules() side by side with an ordinary resource-graph rule and the seeded microsoft-graph
 * rule in the same category and the same scan, and a Log Analytics failure isolates to only that
 * backend's rules — mirrors scan-runner-taxonomy-dispatch.test.ts's coverage of the
 * resource-graph/microsoft-graph split, extended to prove the same holds for all three backends
 * together rather than re-proving the two-backend case.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { rules as rulesTable } from '@/lib/db/tables';
import { getCategory } from '@/lib/db/categories';
import { runCategoryScan } from '@/lib/scan-runner';
import { resetDb } from '../helpers/db';
import { fakeTenantContext, argRow } from '../helpers/fake-azure';

const ARG_RULE_ID = 'test-arg-rule-under-identity-logs';
const LOGS_RULE_ID = 'test-logs-rule-under-identity';

// Same idempotent-delete-then-insert pattern as scan-runner-taxonomy-dispatch.test.ts's
// insertArgRuleUnderIdentity() — await resetDb() deliberately preserves the seeded rules table.
async function insertArgRuleUnderIdentity(): Promise<void> {
  await execRun(db.delete(rulesTable).where(eq(rulesTable.id, ARG_RULE_ID)));
  await execRun(db.insert(rulesTable).values({
    id: ARG_RULE_ID,
    name: ARG_RULE_ID,
    description: 'a resource-graph rule filed under the identity category',
    category: 'identity',
    severity: 'medium',
    enabled: true,
    scope: JSON.stringify({ level: 'subscription' }),
    resourceTypes: JSON.stringify([]),
    conditions: JSON.stringify([]),
    rawKql: 'resources | where type == "microsoft.compute/virtualmachines"',
    type: 'custom',
  }));
}

async function insertLogsRuleUnderIdentity(): Promise<void> {
  await execRun(db.delete(rulesTable).where(eq(rulesTable.id, LOGS_RULE_ID)));
  await execRun(db.insert(rulesTable).values({
    id: LOGS_RULE_ID,
    name: LOGS_RULE_ID,
    description: 'a log-analytics rule filed under the identity category',
    category: 'identity',
    severity: 'medium',
    enabled: true,
    scope: JSON.stringify({ level: 'subscription' }),
    resourceTypes: JSON.stringify([]),
    conditions: JSON.stringify([]),
    queryBackend: 'log-analytics',
    logsQuery: JSON.stringify({ kql: 'SigninLogs | where ResultType != 0', timeWindowDays: 30 }),
    type: 'custom',
  }));
}

async function identityCategory() {
  const category = await getCategory('identity');
  expect(category, "expected the seeded 'identity' category to exist").toBeTruthy();
  return category!;
}

function graphAppWithExpiringSecret(): Record<string, unknown>[] {
  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
  return [{
    id: 'app-1',
    displayName: 'Test App',
    appId: 'appid-1',
    passwordCredentials: [{ displayName: 'a secret', endDateTime: soon, keyId: 'key-1' }],
    keyCredentials: [],
  }];
}

describe('runCategoryScan dispatches log-analytics rules through runLawRules (spec 036)', () => {
  beforeEach(async () => {
    await resetDb();
    await insertArgRuleUnderIdentity();
    await insertLogsRuleUnderIdentity();
  });

  it('runs resource-graph, microsoft-graph and log-analytics rules under the same category in one scan', async () => {
    const category = await identityCategory();
    const ctx = fakeTenantContext({
      rows: [argRow()],
      graphRows: graphAppWithExpiringSecret(),
      logsRows: [{ UserId: 'u1' }],
    });

    const outcome = await runCategoryScan(category, {
      ctx,
      ruleIds: [ARG_RULE_ID, 'cred:app-secret-expiring', LOGS_RULE_ID],
    });

    const ruleIds = outcome.summary.findings.map(f => f.ruleId).sort();
    expect(ruleIds).toEqual([ARG_RULE_ID, 'cred:app-secret-expiring', LOGS_RULE_ID].sort());
    expect(outcome.summary.coverage).toBe('complete');
    expect(outcome.summary.incompleteRules).toEqual([]);

    // Light sanity check that this finding really came from the activity engine, not ARG/Graph —
    // the deeper kind:'activity'/dimensionKey mechanics have their own coverage in core's
    // law-runner tests; this is only proving dispatch routed to the right engine.
    const logsFinding = outcome.summary.findings.find(f => f.ruleId === LOGS_RULE_ID);
    expect(logsFinding?.kind).toBe('activity');
    expect(logsFinding?.resourceId).toBeUndefined();
  });

  it('a failed Log Analytics call leaves the resource-graph and microsoft-graph rules in the same category unaffected', async () => {
    const category = await identityCategory();
    const ctx = fakeTenantContext({
      rows: [argRow()],
      graphRows: graphAppWithExpiringSecret(),
      logsFailWith: new Error('Log Analytics unavailable'),
    });

    const outcome = await runCategoryScan(category, {
      ctx,
      ruleIds: [ARG_RULE_ID, 'cred:app-secret-expiring', LOGS_RULE_ID],
    });

    expect(outcome.summary.findings.map(f => f.ruleId).sort()).toEqual([ARG_RULE_ID, 'cred:app-secret-expiring'].sort());
    expect(outcome.summary.coverage).toBe('partial');
    expect(outcome.summary.incompleteRules.map(r => r.ruleId)).toEqual([LOGS_RULE_ID]);
  });
});
