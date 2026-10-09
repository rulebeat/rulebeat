/**
 * Issue #191: rules no longer have a Deadline or a Group column, and findings no longer store a
 * deadline or a group value. A dev database that still has those four columns (and values in them)
 * must start, seed and scan as it did, because every INSERT and SELECT names its columns and the
 * leftover ones are nullable. The old columns are added back here on a migrated test database.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { dbKind } from '@/lib/db/backend';
import { dbReady, rawSqlite, pgDb } from '@/lib/db/client';
import { runSeeds } from '@/lib/db/migrate';
import { seedPg } from '@/lib/db/pg/seeds';
import { getCategory } from '@/lib/db/categories';
import { listFindings } from '@/lib/db/findings';
import { loadRules } from '@/lib/rules';
import { runCategoryScan } from '@/lib/scan-runner';
import { buildExplorerData } from '@/lib/explorer-data';
import { resetDb, clearRules, execRaw, columnsOf } from '../helpers/db';
import { SERVICE_RETIREMENTS_RULE_ID } from '../helpers/catalogue';
import { fakeTenantContext, TEST_SUB_A } from '../helpers/fake-azure';

const dataDir = join(resolve(__dirname, '..', '..'), 'data');
const VM = `/subscriptions/${TEST_SUB_A}/resourcegroups/rg-legacy/providers/microsoft.compute/virtualmachines/vm-one`;

async function addLeftoverColumn(table: string, column: string): Promise<void> {
  if (dbKind === 'pg') {
    await execRaw(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} TEXT`);
  } else if (!columnsOf(table).includes(column)) {
    await execRaw(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  }
}

async function scan() {
  const ctx = fakeTenantContext({
    rows: kql => (/^\s*advisorresources/i.test(kql)
      ? [{
          id: VM, name: 'vm-one', subscriptionId: TEST_SUB_A, resourceGroup: 'rg-legacy',
          retiringFeature: 'VM image', retirementDate: '2026-09-30', recommendationTypeId: 'type-1',
        }]
      : []),
  });
  return runCategoryScan((await getCategory('reliability'))!, { ctx, ruleIds: [SERVICE_RETIREMENTS_RULE_ID] });
}

describe('a dev database that still has the Deadline and Group columns', () => {
  beforeEach(async () => {
    await resetDb();
    await execRaw('DELETE FROM rule_versions');
    await clearRules();
    await addLeftoverColumn('rules', 'deadline_field');
    await addLeftoverColumn('rules', 'group_field');
    await addLeftoverColumn('findings', 'deadline');
    await addLeftoverColumn('findings', 'group_value');
  });

  it('seeds, scans and reads findings back, and the leftover columns never reach a rule or a finding', async () => {
    await dbReady;
    if (pgDb) await seedPg(pgDb, dataDir, { skipOwnerBootstrap: true });
    else runSeeds(rawSqlite!, dataDir, { skipOwnerBootstrap: true });

    const seeded = (await loadRules()).find(r => r.id === SERVICE_RETIREMENTS_RULE_ID);
    expect(seeded?.kind).toBe('advisory');
    expect(seeded).not.toHaveProperty('deadlineField');
    expect(seeded).not.toHaveProperty('groupField');

    // A row written before the columns were dropped holds values in them; a rescan updates it.
    const first = await scan();
    expect(first.summary.incompleteRules).toEqual([]);
    await execRaw(`UPDATE findings SET deadline = '2026-09-30T00:00:00.000Z', group_value = 'VM image'`);
    await execRaw(`UPDATE rules SET deadline_field = 'retirementDate', group_field = 'retirementFeatureName'`);
    const second = await scan();
    expect(second.summary.incompleteRules).toEqual([]);

    const found = (await listFindings()).filter(f => f.ruleId === SERVICE_RETIREMENTS_RULE_ID);
    expect(found).toHaveLength(1);
    expect(found[0].status).toBe('active');
    expect(found[0].timesSeen).toBe(2);
    expect(found[0]).not.toHaveProperty('deadline');
    expect(found[0]).not.toHaveProperty('groupValue');
    expect(found[0].evidence).toMatchObject({ retiringFeature: 'VM image', retirementDate: '2026-09-30' });

    const advisories = (await buildExplorerData({ kinds: ['advisory'] })).findings;
    expect(advisories.map(f => f.resourceId)).toEqual([VM]);
    const rule = (await loadRules()).find(r => r.id === SERVICE_RETIREMENTS_RULE_ID)!;
    expect(rule).not.toHaveProperty('deadlineField');
    expect(rule).not.toHaveProperty('groupField');
  });
});
