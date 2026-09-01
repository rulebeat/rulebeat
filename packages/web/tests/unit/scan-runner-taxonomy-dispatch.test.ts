/**
 * Spec 029 — await runCategoryScan() dispatches purely on each enabled rule's queryBackend
 * (microsoft-graph -> runGraphRules, everything else -> runRules/ARG), never on
 * category.isSpecial. Before 029 the 'identity' category bypassed runRules() entirely for every
 * rule filed under it; this proves an ordinary resource-graph rule filed under 'identity' now runs
 * and reports findings side by side with the seeded microsoft-graph rules in the same category.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { rules as rulesTable } from '@/lib/db/schema';
import { getCategory } from '@/lib/db/categories';
import { runCategoryScan } from '@/lib/scan-runner';
import { resetDb } from '../helpers/db';
import { fakeTenantContext, argRow } from '../helpers/fake-azure';

const ARG_RULE_ID = 'test-arg-rule-under-identity';

// await resetDb() deliberately leaves the seeded `rules` table (including the two real identity rules
// this suite depends on) intact — see tests/helpers/db.ts. await clearRules() would wipe those along with
// this test's own rule, so instead delete just this rule by id before each insert, making the insert
// idempotent across the two `it` blocks that share this file's database connection.
function insertArgRuleUnderIdentity(): void {
  db.delete(rulesTable).where(eq(rulesTable.id, ARG_RULE_ID)).run();
  db.insert(rulesTable).values({
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
  }).run();
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

describe("runCategoryScan dispatches by queryBackend, not category.isSpecial (spec 029)", () => {
  beforeEach(async () => {
    await resetDb();
    insertArgRuleUnderIdentity();
  });

  it('runs the resource-graph rule and the seeded microsoft-graph rule under the same category in one scan', async () => {
    const category = await identityCategory();
    const ctx = fakeTenantContext({
      rows: [argRow()],
      graphRows: graphAppWithExpiringSecret(),
    });

    const outcome = await runCategoryScan(category, {
      ctx,
      ruleIds: [ARG_RULE_ID, 'cred:app-secret-expiring'],
    });

    const ruleIds = outcome.summary.findings.map(f => f.ruleId).sort();
    expect(ruleIds).toEqual([ARG_RULE_ID, 'cred:app-secret-expiring'].sort());
    expect(outcome.summary.coverage).toBe('complete');
    expect(outcome.summary.incompleteRules).toEqual([]);
  });

  it('a failed Graph call leaves the resource-graph rule in the same category unaffected', async () => {
    const category = await identityCategory();
    const ctx = fakeTenantContext({
      rows: [argRow()],
      graphFailWith: new Error('Graph unavailable'),
    });

    const outcome = await runCategoryScan(category, {
      ctx,
      ruleIds: [ARG_RULE_ID, 'cred:app-secret-expiring'],
    });

    expect(outcome.summary.findings.map(f => f.ruleId)).toEqual([ARG_RULE_ID]);
    expect(outcome.summary.coverage).toBe('partial');
    expect(outcome.summary.incompleteRules.map(r => r.ruleId)).toEqual(['cred:app-secret-expiring']);
  });
});
