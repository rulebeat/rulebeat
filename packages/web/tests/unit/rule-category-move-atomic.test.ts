/**
 * #379: a write that moves a rule to another category refreshes both categories' daily snapshots in
 * the same transaction as the move. Seen from outside: when the refresh fails, the move is rolled
 * back with it, so a rule's findings are never in a category its snapshots do not know about.
 *
 * Startup seeding is the one write that cannot do this (the seeders run before the async database
 * is usable), so it is covered in rule-category-move.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { rules as rulesTable, ruleVersions } from '@/lib/db/tables';
import { getCategory } from '@/lib/db/categories';
import { listFindings } from '@/lib/db/findings';
import { approveLibraryRequest, createLibraryRequest } from '@/lib/db/library-requests';
import { createPersonalRule } from '@/lib/db/personal-rules';
import { createUser } from '@/lib/db/users';
import { runSeeds } from '@/lib/db/migrate';
import { seedPg } from '@/lib/db/pg/seeds';
import { dbReady, pgDb, rawSqlite } from '@/lib/db/client';
import { loadRules, switchRuleVersion, updateRule } from '@/lib/rules';
import { runCategoryScan } from '@/lib/scan-runner';
import { join, resolve } from 'node:path';
import { resetDb } from '../helpers/db';
import { catalogueOf, shippedRule } from '../helpers/catalogue';
import { fakeTenantContext, argRow, TEST_SUB_A } from '../helpers/fake-azure';
import { EVERYTHING_ACCESS } from '../helpers/access';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';
import type { ShippedCatalogue } from '@/lib/shipped-catalogue';

const failure = vi.hoisted(() => ({ on: false }));

vi.mock('@/lib/db/snapshots', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/snapshots')>();
  return {
    ...actual,
    upsertDailySnapshot: (...args: Parameters<typeof actual.upsertDailySnapshot>) => {
      if (failure.on) return Promise.reject(new Error('snapshot refresh failed'));
      return actual.upsertDailySnapshot(...args);
    },
  };
});

const RULE_ID = 'atomic-rule';
const BUILTIN_ID = 'aaaaaaaa-0000-4000-8000-0000000000e1';
const dataDir = join(resolve(__dirname, '..', '..'), 'data');

async function seed(catalogue: ShippedCatalogue): Promise<void> {
  await dbReady;
  if (pgDb) await seedPg(pgDb, dataDir, { skipOwnerBootstrap: true, catalogue });
  else runSeeds(rawSqlite!, dataDir, { skipOwnerBootstrap: true, catalogue });
}

const categoriesOf = async (ruleId: string) => [...new Set(
  (await listFindings(EVERYTHING_ACCESS)).filter(f => f.ruleId === ruleId).map(f => f.category),
)];

beforeEach(async () => {
  failure.on = false;
  await resetDb();
  await execRun(db.delete(rulesTable).where(eq(rulesTable.id, RULE_ID)));
  await execRun(db.insert(rulesTable).values({
    id: RULE_ID, name: RULE_ID, description: 'test rule', category: 'security', severity: 'medium', enabled: true,
    scope: JSON.stringify({ level: 'subscription' }), resourceTypes: JSON.stringify([]), conditions: JSON.stringify([]),
    rawKql: 'resources | where type == "microsoft.compute/virtualmachines"', type: 'custom',
  }));
  const security = (await getCategory('security'))!;
  await runCategoryScan(security, {
    access: EVERYTHING_ACCESS, ctx: fakeTenantContext({ rows: [argRow({ name: 'vm-1' })] }), ruleIds: [RULE_ID],
  });
});

describe('when the snapshot refresh fails, the move is not kept', () => {
  it('for a custom rule edit', async () => {
    failure.on = true;
    await expect(updateRule(RULE_ID, { category: 'compliance' })).rejects.toThrow('snapshot refresh failed');
    failure.on = false;
    expect(await categoriesOf(RULE_ID)).toEqual(['security']);
    expect((await loadRules()).find(r => r.id === RULE_ID)!.category).toBe('security');
  });

  it('for a version switch', async () => {
    const v1 = shippedRule({ id: BUILTIN_ID, definition: { category: 'security' } });
    const v2 = shippedRule({
      id: BUILTIN_ID, version: '2.0.0', releaseNote: 'Moved.',
      definition: { category: 'compliance', rawKql: 'Resources | where name == "new" | project id' },
    });
    await execRun(db.delete(ruleVersions).where(eq(ruleVersions.ruleId, BUILTIN_ID)));
    await execRun(db.delete(rulesTable).where(eq(rulesTable.id, BUILTIN_ID)));
    await seed(catalogueOf(v1));
    await storeScan([syntheticFinding('vm-b1', [{ n: 1 }], { ruleId: BUILTIN_ID })],
      { scanId: 'atomic-switch', finishedAt: new Date().toISOString() });
    await seed(catalogueOf(v2));

    failure.on = true;
    await expect(switchRuleVersion(BUILTIN_ID, '2.0.0')).rejects.toThrow('snapshot refresh failed');
    failure.on = false;
    expect(await categoriesOf(BUILTIN_ID)).toEqual(['security']);
  });

  it('for a Library request approval', async () => {
    const author = await createUser({ email: 'author@example.com', role: 'editor', access: [] });
    const reviewer = await createUser({ email: 'reviewer@example.com', role: 'admin', access: [] });
    if ('error' in author || 'error' in reviewer) throw new Error('could not create the people');
    const personal = await createPersonalRule(author.user.id, {
      name: 'Updated VM rule', description: 'Flags virtual machines', category: 'security', severity: 'medium',
      queryBackend: 'resource-graph', kind: 'state', tags: [], scope: { level: 'subscription', subscriptions: [TEST_SUB_A] },
      resourceTypes: [], conditions: [], rawKql: 'resources | where type == "microsoft.compute/virtualmachines"',
    });
    const request = await createLibraryRequest(personal, author.user.id, undefined, RULE_ID);
    if (!request.ok) throw new Error(request.reason);

    failure.on = true;
    await expect(approveLibraryRequest(request.request.id, reviewer.user.id, { category: 'compliance' }))
      .rejects.toThrow('snapshot refresh failed');
    failure.on = false;
    expect(await categoriesOf(RULE_ID)).toEqual(['security']);
  });
});
