/**
 * #402: a scan records the rules it ran, so a rule's Outcome can tell a scan that ran it from one that
 * came before the rule existed or was enabled. Driven through the scan runner over the fake Azure, and
 * read back through the repository the Rules tab reads with.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { rules as rulesTable } from '@/lib/db/tables';
import { getCategory } from '@/lib/db/categories';
import { runCategoryScan } from '@/lib/scan-runner';
import { listOutcomeScans } from '@/lib/scan-history';
import { resetDb } from '../helpers/db';
import { EVERYTHING_ACCESS } from '../helpers/access';
import { argRow, fakeTenantContext } from '../helpers/fake-azure';
import { seedRules } from '../helpers/stored-scans';

const RULES = [
  { id: 'ran-rule-a', name: 'ran rule a', severity: 'high', vms: ['vm-a'] },
  { id: 'ran-rule-b', name: 'ran rule b', severity: 'high', vms: [] as string[] },
  { id: 'ran-rule-off', name: 'ran rule off', severity: 'high', vms: [] as string[] },
];

beforeEach(async () => {
  await resetDb();
  await seedRules(RULES);
  await execRun(db.update(rulesTable).set({ enabled: false }).where(eq(rulesTable.id, 'ran-rule-off')));
});

async function scanOnce(ruleIds?: string[]) {
  const category = (await getCategory('identity'))!;
  await runCategoryScan(category, {
    access: EVERYTHING_ACCESS,
    ctx: fakeTenantContext({ rows: kql => (kql.includes('"ran-rule-a"') ? [argRow({ name: 'vm-a' })] : []) }),
    ruleIds,
  });
  return (await listOutcomeScans(EVERYTHING_ACCESS)).get('identity')!;
}

describe('a scan records the rules it ran', () => {
  it('lists the enabled rules of the category, and leaves a disabled rule out', async () => {
    const [scan] = await scanOnce();
    expect(scan!.ranRuleIds).toEqual(expect.arrayContaining(['ran-rule-a', 'ran-rule-b']));
    expect(scan!.ranRuleIds).not.toContain('ran-rule-off');
    expect(scan!.incompleteRuleIds).toEqual([]);
  });

  it('lists only the rules a targeted run was limited to', async () => {
    const [scan] = await scanOnce(['ran-rule-b']);
    expect(scan!.ranRuleIds).toEqual(['ran-rule-b']);
  });
});
