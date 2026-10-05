/**
 * A rule's category can be changed after it has findings. Its existing findings still carry the
 * old category, so the next scan of the new category must still resolve the ones the rule no
 * longer returns. Otherwise they stay active forever: the new category's scan did not look for
 * them, and the old category's scan no longer runs the rule.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getCategory } from '@/lib/db/categories';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { rules as rulesTable } from '@/lib/db/tables';
import { listFindings } from '@/lib/db/findings';
import { runCategoryScan } from '@/lib/scan-runner';
import { resetDb, clearRules } from '../helpers/db';
import { fakeTenantContext, argRow } from '../helpers/fake-azure';

const RULE_ID = 'test-rule-category-change';
const OTHER_RULE_ID = 'test-rule-stays-in-security';

async function insertRule(id: string): Promise<void> {
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
    rawKql: 'resources | where type == "microsoft.compute/virtualmachines"',
    type: 'custom',
  }));
}

async function statusOf(ruleId: string, resourceName: string): Promise<string | undefined> {
  return (await listFindings()).find(f => f.ruleId === ruleId && f.resourceName === resourceName)?.status;
}

describe('a rule whose category changes after it has findings', () => {
  beforeEach(async () => {
    await resetDb();
    await clearRules();
    await insertRule(RULE_ID);
  });

  it('resolves the findings it no longer returns on its next scan in the new category', async () => {
    const security = (await getCategory('security'))!;
    const compliance = (await getCategory('compliance'))!;

    await runCategoryScan(security, {
      ctx: fakeTenantContext({ rows: [argRow({ name: 'vm-1' }), argRow({ name: 'vm-2' })] }),
      ruleIds: [RULE_ID],
    });
    await execRun(db.update(rulesTable).set({ category: 'compliance' }).where(eq(rulesTable.id, RULE_ID)));
    await runCategoryScan(compliance, {
      ctx: fakeTenantContext({ rows: [argRow({ name: 'vm-1' })] }),
      ruleIds: [RULE_ID],
    });

    expect(await statusOf(RULE_ID, 'vm-1')).toBe('active');
    expect(await statusOf(RULE_ID, 'vm-2')).toBe('fixed');
  });

  it('still never resolves findings of a rule the scan did not run', async () => {
    await insertRule(OTHER_RULE_ID);
    const security = (await getCategory('security'))!;

    await runCategoryScan(security, {
      ctx: fakeTenantContext({ rows: [argRow({ name: 'vm-1' })] }),
      ruleIds: [RULE_ID, OTHER_RULE_ID],
    });
    await runCategoryScan(security, {
      ctx: fakeTenantContext({ rows: [] }),
      ruleIds: [RULE_ID],
    });

    expect(await statusOf(RULE_ID, 'vm-1')).toBe('fixed');
    expect(await statusOf(OTHER_RULE_ID, 'vm-1')).toBe('active');
  });
});
