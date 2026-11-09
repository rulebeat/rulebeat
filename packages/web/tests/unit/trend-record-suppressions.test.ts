/**
 * Suppressions record their cells (ADR 0012). Each suppression write is performed through its public function with an
 * injected clock, and the assertions are on the cells it left and on a full recount writing nothing afterwards: if the
 * write did not move the counts between `open_count` and `suppressed_count` in its own transaction, the recount would
 * find the rows it should have found. A suppression whose record write fails is not saved, here and through the routes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import type { Rule } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { inTransaction, many, run } from '@/lib/db/exec';
import { findings as findingsTable, trendCells } from '@/lib/db/tables';
import { recountTrend } from '@/lib/db/trend-record';
import { createUser } from '@/lib/db/users';
import { createRule } from '@/lib/rules';
import { addSuppression, loadSuppressions, removeSuppression, saveSuppressions } from '@/lib/suppressions';
import type { Suppression } from '@/lib/types';
import { clearRules, resetDb } from '../helpers/db';
import { EVERYTHING_ACCESS } from '../helpers/access';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
vi.mock('@/lib/azure-credential', () => ({
  createTenantContext: async () => { throw new Error('not configured in this test file'); },
}));

const record = vi.hoisted(() => ({ fail: false }));
vi.mock('@/lib/db/trend-record', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db/trend-record')>('@/lib/db/trend-record');
  return {
    ...actual,
    recountTrend: (...args: Parameters<typeof actual.recountTrend>) =>
      record.fail ? Promise.reject(new Error('tenant 00000000-aaaa record write failed')) : actual.recountTrend(...args),
  };
});

const suppressionsRoute = await import('@/app/api/suppressions/route');
const suppressionRoute = await import('@/app/api/suppressions/[id]/route');

const KQL = 'resources | where type =~ "microsoft.compute/virtualmachines" | project id, name, type, location, resourceGroup, subscriptionId';
const T0 = new Date('2026-03-09T08:00:00.000Z');
const T1 = new Date('2026-03-10T09:00:00.000Z');
const T2 = new Date('2026-03-11T10:30:00.000Z');
const T3 = new Date('2026-03-12T11:45:00.000Z');

let counter = 0;
const uniq = (label: string) => `${label} ${++counter} ${Math.random().toString(36).slice(2)}`;

async function ruleWithFindings(count: number): Promise<{ rule: Rule; fingerprints: string[] }> {
  const rule: Rule = {
    id: globalThis.crypto.randomUUID(), name: uniq('rule'), description: 'a test rule', category: 'security', severity: 'high',
    enabled: true, type: 'custom', scope: { level: 'subscription' }, resourceTypes: [], conditions: [], rawKql: KQL,
    queryBackend: 'resource-graph', kind: 'state',
  };
  const created = await createRule(rule, { now: T0 });
  if (!created.ok) throw new Error('could not create the rule');
  const fingerprints: string[] = [];
  for (let i = 0; i < count; i++) {
    const fingerprint = uniq('fp');
    fingerprints.push(fingerprint);
    await run(db.insert(findingsTable).values({
      fingerprint, ruleId: rule.id, category: 'security', severity: 'high', kind: 'state', subscriptionId: 'sub-1', resourceGroup: 'rg-1',
      placement: 'resource', title: 't', status: 'active', firstSeenAt: '2026-03-01T00:00:00.000Z', lastSeenAt: '2026-03-01T00:00:00.000Z',
    }));
  }
  await inTransaction(tx => recountTrend(tx, { now: T1 }));
  return { rule, fingerprints };
}

const suppression = (fingerprint: string, over: Partial<Suppression> = {}): Suppression => ({
  id: globalThis.crypto.randomUUID(), fingerprint, reason: 'accepted', suppressedAt: T1.toISOString(), ...over,
});

const countsOf = async (ruleId: string) =>
  (await many(db.select().from(trendCells).where(eq(trendCells.ruleId, ruleId)).orderBy(asc(trendCells.seq))))
    .map(c => [c.openCount, c.suppressedCount, c.changedAt]);

/** The record agrees with the findings and suppressions: a recount of everything has nothing to write. */
async function expectRecordComplete(): Promise<void> {
  expect(await inTransaction(tx => recountTrend(tx, { now: new Date('2026-04-01T00:00:00.000Z') }))).toEqual({ cells: 0, facts: 0 });
}

beforeEach(async () => {
  await resetDb();
  await clearRules();
  record.fail = false;
});

describe('adding a suppression', () => {
  it('moves the finding from open to suppressed, dated by the clock, and a recount after it writes nothing', async () => {
    const { rule, fingerprints } = await ruleWithFindings(2);

    await addSuppression(suppression(fingerprints[0]), { now: T2 });

    expect(await countsOf(rule.id)).toEqual([[2, 0, T1.toISOString()], [1, 1, T2.toISOString()]]);
    await expectRecordComplete();
  });

  it('writes no cell for a fingerprint no finding holds', async () => {
    const { rule } = await ruleWithFindings(1);

    await addSuppression(suppression('no-such-finding'), { now: T2 });

    expect(await countsOf(rule.id)).toEqual([[1, 0, T1.toISOString()]]);
    await expectRecordComplete();
  });

  it('counts a suppression that has already expired as open', async () => {
    const { rule, fingerprints } = await ruleWithFindings(1);

    await addSuppression(suppression(fingerprints[0], { expiresAt: T1.toISOString() }), { now: T2 });

    expect(await countsOf(rule.id)).toEqual([[1, 0, T1.toISOString()]]);
    await expectRecordComplete();
  });
});

describe('removing a suppression', () => {
  it('moves the finding back to open, and a recount after it writes nothing', async () => {
    const { rule, fingerprints } = await ruleWithFindings(2);
    const added = suppression(fingerprints[0]);
    await addSuppression(added, { now: T2 });

    expect(await removeSuppression(added.id, undefined, { now: T3 })).toMatchObject({ id: added.id });

    expect(await countsOf(rule.id)).toEqual([[2, 0, T1.toISOString()], [1, 1, T2.toISOString()], [2, 0, T3.toISOString()]]);
    await expectRecordComplete();
  });

  it('writes nothing for a suppression that is not there', async () => {
    const { rule } = await ruleWithFindings(1);

    expect(await removeSuppression('no-such-suppression', undefined, { now: T2 })).toBeNull();

    expect(await countsOf(rule.id)).toEqual([[1, 0, T1.toISOString()]]);
  });
});

describe('replacing all suppressions', () => {
  it('records the whole new set, and a recount after it writes nothing', async () => {
    const { rule, fingerprints } = await ruleWithFindings(3);
    await addSuppression(suppression(fingerprints[0]), { now: T2 });

    await saveSuppressions([suppression(fingerprints[1]), suppression(fingerprints[2])], { now: T3 });

    expect(await countsOf(rule.id)).toEqual([[3, 0, T1.toISOString()], [2, 1, T2.toISOString()], [1, 2, T3.toISOString()]]);
    await expectRecordComplete();
  });

  it('records the empty set', async () => {
    const { rule, fingerprints } = await ruleWithFindings(1);
    await addSuppression(suppression(fingerprints[0]), { now: T2 });

    await saveSuppressions([], { now: T3 });

    expect((await countsOf(rule.id)).at(-1)).toEqual([1, 0, T3.toISOString()]);
    await expectRecordComplete();
  });
});

describe('a suppression whose record write fails', () => {
  it('is not saved when it is added', async () => {
    const { rule, fingerprints } = await ruleWithFindings(1);
    record.fail = true;

    await expect(addSuppression(suppression(fingerprints[0]), { now: T2 })).rejects.toThrow('record write failed');

    expect(await loadSuppressions(EVERYTHING_ACCESS)).toEqual([]);
    expect(await countsOf(rule.id)).toEqual([[1, 0, T1.toISOString()]]);
  });

  it('is not removed when it is removed', async () => {
    const { fingerprints } = await ruleWithFindings(1);
    const added = suppression(fingerprints[0]);
    await addSuppression(added, { now: T2 });
    record.fail = true;

    await expect(removeSuppression(added.id, undefined, { now: T3 })).rejects.toThrow('record write failed');

    expect(await loadSuppressions(EVERYTHING_ACCESS)).toHaveLength(1);
  });

  describe('through the routes', () => {
    const json = (method: string, body?: unknown) => new Request('http://localhost/api/suppressions', {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });

    beforeEach(async () => {
      mockAuth.mockReset();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const created = await createUser({ email: 'admin@example.com', role: 'admin' });
      if ('error' in created) throw new Error(created.error);
      mockAuth.mockResolvedValue({ user: { uid: created.user.id } });
    });

    it('answers a create with the stable message and saves nothing', async () => {
      const { fingerprints } = await ruleWithFindings(1);
      record.fail = true;

      const res = await suppressionsRoute.POST(json('POST', { fingerprint: fingerprints[0], reason: 'accepted' }));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Could not suppress the finding. Check the RuleBeat server logs for details.' });
      expect(await loadSuppressions(EVERYTHING_ACCESS)).toEqual([]);
    });

    it('answers a delete with the stable message and keeps the suppression', async () => {
      const { fingerprints } = await ruleWithFindings(1);
      const added = suppression(fingerprints[0]);
      await addSuppression(added);
      record.fail = true;

      const res = await suppressionRoute.DELETE(json('DELETE'), { params: Promise.resolve({ id: added.id }) });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Could not remove the suppression. Check the RuleBeat server logs for details.' });
      expect(await loadSuppressions(EVERYTHING_ACCESS)).toHaveLength(1);
    });
  });
});
