/**
 * Trust in dashboard numbers (map #320): a category's points are computed from one consistent view of the
 * database. On Postgres the writer's transaction runs at REPEATABLE READ (as lib/db/exec.ts's read
 * transactions do), so a row another connection commits while the transaction is open is not counted by
 * a later read in it; at READ COMMITTED each statement would see it, and the point would mix two states.
 *
 * Postgres only by nature: on SQLite the one shared connection and its lock mean nothing can commit mid-transaction.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbKind } from '@/lib/db/backend';
import { db } from '@/lib/db/client';
import { run } from '@/lib/db/exec';
import { suppressions as suppressionsTable } from '@/lib/db/tables';
import { refreshSnapshotsFor } from '@/lib/db/snapshots';
import { listFindings } from '@/lib/db/findings';
import { clearRules, execRaw, resetDb } from '../helpers/db';
import { EVERYTHING_ACCESS } from '../helpers/access';
import { insertRuleRow, pointOn, storeFindings, syntheticFinding } from '../helpers/trend-writer';

/** Work to run on another connection once the writer's transaction has read the stored tree. */
const midTransaction = vi.hoisted(() => ({ hook: null as null | (() => Promise<void>) }));

vi.mock('@/lib/db/management-group-hierarchy', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/db/management-group-hierarchy')>();
  return {
    ...real,
    listHierarchyNodes: async (...args: Parameters<typeof real.listHierarchyNodes>) => {
      const nodes = await real.listHierarchyNodes(...args);
      const hook = midTransaction.hook;
      midTransaction.hook = null;
      if (hook) await hook();
      return nodes;
    },
  };
});

const DAY = '2026-05-04';
const at = new Date(`${DAY}T12:00:00.000Z`);

describe.skipIf(dbKind !== 'pg')('a read in the writer\'s transaction does not see what another connection commits meanwhile', () => {
  beforeEach(async () => {
    await resetDb();
    await clearRules();
    await execRaw('DELETE FROM posture_snapshots');
    await insertRuleRow({ id: 'r1' });
    await storeFindings([syntheticFinding('f1', [{ z: 1 }], { ruleId: 'r1' })]);
  });

  it('leaves out a suppression committed after the transaction began, and counts it on the next refresh', async () => {
    const fingerprint = (await listFindings(EVERYTHING_ACCESS))[0]!.fingerprint;
    midTransaction.hook = () => run(db.insert(suppressionsTable).values({
      id: 's1', fingerprint, reason: 'test', suppressedAt: at.toISOString(),
    }));

    await refreshSnapshotsFor(['security'], at);
    expect(midTransaction.hook).toBeNull();
    expect(await pointOn('security', '', DAY)).toMatchObject({ activeFindings: 1, passingRules: 0 });

    await refreshSnapshotsFor(['security'], at);
    expect(await pointOn('security', '', DAY)).toMatchObject({ activeFindings: 0, passingRules: 1 });
  });
});
