/**
 * Azure resource ids are case-insensitive, and Resource Graph does not always return the same
 * casing for the same resource across scans (resource group names are the usual offender). The
 * same resource rescanned with a differently-cased id must stay one finding: not resolved and
 * re-opened as a new one, which would reset its age and detach any suppression on it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { getCategory } from '@/lib/db/categories';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { rules as rulesTable } from '@/lib/db/tables';
import { listFindings } from '@/lib/db/findings';
import { runCategoryScan } from '@/lib/scan-runner';
import { resetDb, clearRules } from '../helpers/db';
import { fakeTenantContext, argRow } from '../helpers/fake-azure';

const RULE_ID = 'test-rule-casing';

async function insertRule(): Promise<void> {
  await execRun(db.insert(rulesTable).values({
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
  }));
}

describe('a resource id whose casing changes between scans', () => {
  beforeEach(async () => {
    await resetDb();
    await clearRules();
    await insertRule();
  });

  it('stays one open finding instead of resolving and re-opening', async () => {
    const category = (await getCategory('security'))!;

    await runCategoryScan(category, { ctx: fakeTenantContext({ rows: [argRow({ name: 'vm-1', resourceGroup: 'RG-APP' })] }), ruleIds: [RULE_ID] });
    const second = await runCategoryScan(category, { ctx: fakeTenantContext({ rows: [argRow({ name: 'vm-1', resourceGroup: 'rg-app' })] }), ruleIds: [RULE_ID] });

    expect(second.newFindings).toHaveLength(0);
    const rows = await listFindings();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('active');
  });
});
