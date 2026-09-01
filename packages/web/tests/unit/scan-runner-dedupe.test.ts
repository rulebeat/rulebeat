/**
 * Spec 017 (RB-QA-019) — a rule whose ARG query returns the same resource twice in one page must
 * count as one finding everywhere, not just in the findings lifecycle table. await syncScanFindings()
 * already dedupes for the lifecycle table on its own (see finding-lifecycle-matrix.test.ts); this
 * suite proves await runCategoryScan() also dedupes the saved scan blob / counts / newFindings before
 * that point is ever reached — the gap Codex's challenge of the spec 017 plan identified.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { computeFingerprint } from '@rulebeat/core';
import { getCategory } from '@/lib/db/categories';
import { db } from '@/lib/db/client';
import { rules as rulesTable } from '@/lib/db/schema';
import { runCategoryScan } from '@/lib/scan-runner';
import { resetDb, clearRules } from '../helpers/db';
import { fakeTenantContext, argRow } from '../helpers/fake-azure';

const RULE_ID = 'test-rule-dup';

function insertRule(): void {
  db.insert(rulesTable).values({
    id: RULE_ID,
    name: RULE_ID,
    description: 'test rule',
    category: 'security',
    severity: 'medium',
    enabled: true,
    scope: JSON.stringify({ level: 'subscription' }),
    resourceTypes: JSON.stringify([]),
    conditions: JSON.stringify([]),
    rawKql: 'resources | where type == "microsoft.compute/virtualmachines"',
    type: 'custom',
  }).run();
}

async function securityCategory() {
  const category = await getCategory('security');
  expect(category, "expected the seeded 'security' category to exist").toBeTruthy();
  return category!;
}

describe('runCategoryScan dedupes a rule returning the same resource twice (spec 017)', () => {
  beforeEach(async () => {
    await resetDb();
    await clearRules();
    insertRule();
  });

  it('the saved scan summary has one finding and one severity count, not two', async () => {
    const category = await securityCategory();
    const row = argRow({ name: 'vm-dup' });
    const fingerprint = computeFingerprint(RULE_ID, row.id as string);

    const ctx = fakeTenantContext({ rows: [row, row] });
    const outcome = await runCategoryScan(category, { ctx, ruleIds: [RULE_ID] });

    expect(outcome.summary.findings).toHaveLength(1);
    expect(outcome.summary.findings[0]!.fingerprint).toBe(fingerprint);
    expect(outcome.summary.counts.medium).toBe(1);
    expect(outcome.newFindings).toHaveLength(1);
  });
});
