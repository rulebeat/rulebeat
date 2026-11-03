/**
 * The trend-record module (ADR 0012): the one place that writes cell and rule fact change rows and the
 * Recorded day marker. Asserted through its public functions on the shared database, so it runs on both
 * backends. The start (first start and every later one) is trend-record-start.test.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { join, resolve } from 'node:path';
import { db, dbReady, pgDb } from '@/lib/db/client';
import { seedPg } from '@/lib/db/pg/seeds';
import { inTransaction, many, run } from '@/lib/db/exec';
import { accessFilterSql } from '@/lib/db/access-filter';
import {
  findings as findingsTable, rules as rulesTable, suppressions as suppressionsTable,
  trendCells, trendRecordedDays, trendRuleFacts,
} from '@/lib/db/tables';
import { mergeCovered, recordRecordedDay, recountTrend, TREND_RECORD_LOCK_KEY, type CoveredEntry } from '@/lib/db/trend-record';
import { buildAccess, parseScope } from '@/lib/access-model';
import { resetDb, clearRules } from '../helpers/db';

const RULE_A = 'trend-rule-a';
const RULE_B = 'trend-rule-b';
const DAY_1 = new Date('2026-03-10T08:00:00.000Z');
const DAY_2 = new Date('2026-03-11T09:30:00.000Z');
const BEFORE_DAY_1 = new Date('2026-03-09T23:00:00.000Z');

async function insertRule(id: string, over: Partial<typeof rulesTable.$inferInsert> = {}): Promise<void> {
  await run(db.insert(rulesTable).values({
    id, name: id, description: 'test', category: 'security', severity: 'medium', enabled: true,
    scope: JSON.stringify({ level: 'resource' }), resourceTypes: '[]', conditions: '[]', type: 'custom', ...over,
  }));
}

let fingerprintCounter = 0;
async function insertFinding(over: Partial<typeof findingsTable.$inferInsert> & { ruleId: string }): Promise<string> {
  const fingerprint = `fp-${++fingerprintCounter}`;
  await run(db.insert(findingsTable).values({
    fingerprint, category: 'security', severity: 'high', kind: 'state', subscriptionId: 'sub-1', resourceGroup: 'rg-1',
    placement: 'resource', title: 't', status: 'active', firstSeenAt: '2026-03-01T00:00:00.000Z', lastSeenAt: '2026-03-01T00:00:00.000Z',
    ...over,
  }));
  return fingerprint;
}

const recount = (now: Date, ruleIds?: string[]) => inTransaction(tx => recountTrend(tx, { now, ruleIds }));
const cells = () => many(db.select().from(trendCells).orderBy(asc(trendCells.seq)));
const facts = () => many(db.select().from(trendRuleFacts).orderBy(asc(trendRuleFacts.seq)));

beforeEach(async () => {
  await resetDb();
  await clearRules();
  await insertRule(RULE_A);
});

describe('recounting cells', () => {
  it('writes one row per non-zero cell, counted per place and severity, with the place lowercased', async () => {
    await insertFinding({ ruleId: RULE_A, subscriptionId: 'SUB-1', resourceGroup: 'RG-A' });
    await insertFinding({ ruleId: RULE_A, subscriptionId: 'sub-1', resourceGroup: 'rg-a' });
    await insertFinding({ ruleId: RULE_A, subscriptionId: 'sub-1', resourceGroup: 'rg-b', severity: 'low' });
    await insertFinding({ ruleId: RULE_A, subscriptionId: '', resourceGroup: null, placement: 'management-group', managementGroupId: 'MG-One', severity: 'medium' });

    await recount(DAY_1);

    const byPlace = (a: { resourceGroup: string; managementGroupId: string }, b: { resourceGroup: string; managementGroupId: string }) =>
      `${a.resourceGroup}/${a.managementGroupId}`.localeCompare(`${b.resourceGroup}/${b.managementGroupId}`);
    expect((await cells()).map(({ seq: _seq, ...c }) => c).sort(byPlace)).toEqual([
      { ruleId: RULE_A, placement: 'resource', subscriptionId: 'sub-1', resourceGroup: 'rg-a', managementGroupId: '', severity: 'high', changedAt: DAY_1.toISOString(), openCount: 2, suppressedCount: 0 },
      { ruleId: RULE_A, placement: 'resource', subscriptionId: 'sub-1', resourceGroup: 'rg-b', managementGroupId: '', severity: 'low', changedAt: DAY_1.toISOString(), openCount: 1, suppressedCount: 0 },
      { ruleId: RULE_A, placement: 'management-group', subscriptionId: '', resourceGroup: '', managementGroupId: 'mg-one', severity: 'medium', changedAt: DAY_1.toISOString(), openCount: 1, suppressedCount: 0 },
    ].sort(byPlace));
  });

  it('counts a finding under an active suppression as suppressed, and one whose suppression expired as open', async () => {
    const live = await insertFinding({ ruleId: RULE_A });
    const expired = await insertFinding({ ruleId: RULE_A });
    await insertFinding({ ruleId: RULE_A });
    await run(db.insert(suppressionsTable).values([
      { id: 's1', fingerprint: live, reason: 'r', suppressedAt: '2026-03-01T00:00:00.000Z', expiresAt: '2026-04-01T00:00:00.000Z' },
      { id: 's2', fingerprint: expired, reason: 'r', suppressedAt: '2026-03-01T00:00:00.000Z', expiresAt: '2026-03-05T00:00:00.000Z' },
    ]));

    await recount(DAY_1);

    const [only] = await cells();
    expect(await cells()).toHaveLength(1);
    expect({ open: only!.openCount, suppressed: only!.suppressedCount }).toEqual({ open: 2, suppressed: 1 });
  });

  it('leaves out fixed findings, activity findings, Advisory findings, and the findings of a rule that is not a Problem rule', async () => {
    await insertRule(RULE_B, { kind: 'advisory' });
    await insertFinding({ ruleId: RULE_A, status: 'fixed' });
    await insertFinding({ ruleId: RULE_A, kind: 'activity' });
    await insertFinding({ ruleId: RULE_A, kind: 'advisory' });
    await insertFinding({ ruleId: RULE_B, kind: 'state' });
    await insertFinding({ ruleId: 'gone-rule' });

    await recount(DAY_1);

    expect(await cells()).toEqual([]);
  });

  it('inserts only the keys that differ, and a second recount of unchanged findings writes nothing', async () => {
    await insertFinding({ ruleId: RULE_A, resourceGroup: 'rg-1' });
    await insertFinding({ ruleId: RULE_A, resourceGroup: 'rg-2' });
    await recount(DAY_1);
    const before = await cells();

    expect((await recount(DAY_2))).toEqual({ cells: 0, facts: 0 });
    expect(await cells()).toEqual(before);

    await insertFinding({ ruleId: RULE_A, resourceGroup: 'rg-2' });
    expect(await recount(DAY_2)).toEqual({ cells: 1, facts: 0 });

    const after = await cells();
    expect(after).toHaveLength(3);
    expect(after.slice(0, 2)).toEqual(before);
    expect(after[2]).toMatchObject({ resourceGroup: 'rg-2', openCount: 2, changedAt: DAY_2.toISOString() });
  });

  it('writes a cell down to 0/0 as its own row when its findings go, and keeps the earlier row', async () => {
    const fingerprint = await insertFinding({ ruleId: RULE_A });
    await recount(DAY_1);
    await run(db.update(findingsTable).set({ status: 'fixed' }).where(eq(findingsTable.fingerprint, fingerprint)));

    await recount(DAY_2);

    expect((await cells()).map(c => [c.changedAt, c.openCount, c.suppressedCount])).toEqual([
      [DAY_1.toISOString(), 1, 0],
      [DAY_2.toISOString(), 0, 0],
    ]);
  });

  it('recounts only the rules it is given', async () => {
    await insertRule(RULE_B);
    await insertFinding({ ruleId: RULE_A });
    await insertFinding({ ruleId: RULE_B });

    await recount(DAY_1, [RULE_B]);

    expect((await cells()).map(c => c.ruleId)).toEqual([RULE_B]);
    expect((await facts()).map(f => f.ruleId)).toEqual([RULE_B]);
  });
});

describe('dating a row', () => {
  it('moves a write dated before its key\'s newest row up to that row, with a higher seq', async () => {
    await insertFinding({ ruleId: RULE_A });
    await recount(DAY_2);
    await insertFinding({ ruleId: RULE_A });

    await recount(BEFORE_DAY_1);

    const rows = await cells();
    expect(rows.map(c => [c.changedAt, c.openCount])).toEqual([[DAY_2.toISOString(), 1], [DAY_2.toISOString(), 2]]);
    expect(rows[1]!.seq).toBeGreaterThan(rows[0]!.seq);
  });

  it('dates a fact row the same way', async () => {
    await recount(DAY_2);
    await run(db.update(rulesTable).set({ enabled: false }).where(eq(rulesTable.id, RULE_A)));

    await recount(BEFORE_DAY_1);

    const rows = await facts();
    expect(rows.map(f => [f.changedAt, f.enabled])).toEqual([[DAY_2.toISOString(), true], [DAY_2.toISOString(), false]]);
    expect(rows[1]!.seq).toBeGreaterThan(rows[0]!.seq);
  });
});

describe('recounting rule facts', () => {
  it('writes one wide row for every rule, enabled or not, and a new one only when a fact changes', async () => {
    await insertRule(RULE_B, { enabled: false, kind: 'advisory', severity: 'low', version: '1.2.0', lastRunStatus: 'success', scope: '{"level":"subscription"}' });

    await recount(DAY_1);

    const first = await facts();
    expect(first.map(({ seq: _seq, ...f }) => f).sort((a, b) => a.ruleId.localeCompare(b.ruleId))).toEqual([
      {
        ruleId: RULE_A, changedAt: DAY_1.toISOString(), enabled: true, kind: 'state', severity: 'medium', scope: '{"level":"resource"}',
        runningVersion: null, lastRunStatus: null, deleted: false,
        lastName: null, lastCategory: null, lastCategoryLabel: null, lastTags: null, lastSource: null,
      },
      {
        ruleId: RULE_B, changedAt: DAY_1.toISOString(), enabled: false, kind: 'advisory', severity: 'low', scope: '{"level":"subscription"}',
        runningVersion: '1.2.0', lastRunStatus: 'success', deleted: false,
        lastName: null, lastCategory: null, lastCategoryLabel: null, lastTags: null, lastSource: null,
      },
    ]);

    expect(await recount(DAY_2)).toEqual({ cells: 0, facts: 0 });
    await run(db.update(rulesTable).set({ lastRunStatus: 'failed' }).where(eq(rulesTable.id, RULE_A)));
    expect(await recount(DAY_2)).toEqual({ cells: 0, facts: 1 });
    expect((await facts()).filter(f => f.ruleId === RULE_A).map(f => f.lastRunStatus)).toEqual([null, 'failed']);
  });

  it('writes a deletion row and takes the cells of a rule that is gone down to 0', async () => {
    await insertFinding({ ruleId: RULE_A });
    await recount(DAY_1);
    await run(db.delete(rulesTable).where(eq(rulesTable.id, RULE_A)));

    await recount(DAY_2);

    expect((await facts()).map(f => [f.changedAt, f.deleted])).toEqual([[DAY_1.toISOString(), false], [DAY_2.toISOString(), true]]);
    expect((await cells()).map(c => [c.changedAt, c.openCount])).toEqual([[DAY_1.toISOString(), 1], [DAY_2.toISOString(), 0]]);
  });
});

describe('the Recorded day marker', () => {
  const entry = (over: Partial<CoveredEntry> = {}): CoveredEntry => ({ category: 'security', tenantId: 't1', path: null, ruleIds: ['a'], ...over });

  it('is written once for today with record version 1, its first time and empty coverage', async () => {
    await inTransaction(tx => recordRecordedDay(tx, { now: DAY_1 }));
    await inTransaction(tx => recordRecordedDay(tx, { now: new Date('2026-03-10T20:00:00.000Z') }));

    expect(await many(db.select().from(trendRecordedDays))).toEqual([
      { day: '2026-03-10', recordVersion: 1, firstRecordedAt: DAY_1.toISOString(), covered: '[]' },
    ]);
  });

  it('merges the coverage a later write adds into the day\'s entry', async () => {
    await inTransaction(tx => recordRecordedDay(tx, { now: DAY_1, covered: [entry({ ruleIds: ['a'] })] }));
    await inTransaction(tx => recordRecordedDay(tx, { now: DAY_1, covered: [entry({ ruleIds: ['b'] }), entry({ category: 'cost' })] }));

    const [row] = await many(db.select().from(trendRecordedDays));
    expect(JSON.parse(row!.covered)).toEqual([
      { category: 'cost', tenantId: 't1', path: null, ruleIds: ['a'] },
      { category: 'security', tenantId: 't1', path: null, ruleIds: ['a', 'b'] },
    ]);
    expect(row!.firstRecordedAt).toBe(DAY_1.toISOString());
  });

  describe('mergeCovered', () => {
    it('merges entries of one category, tenant and path by the union of their rule ids', () => {
      expect(mergeCovered([entry({ ruleIds: ['b', 'a'] })], [entry({ ruleIds: ['c', 'a'] })])).toEqual([entry({ ruleIds: ['a', 'b', 'c'] })]);
    });

    it('lets null, every enabled rule in the category, absorb any list', () => {
      expect(mergeCovered([entry({ ruleIds: ['a'] })], [entry({ ruleIds: null })])).toEqual([entry({ ruleIds: null })]);
      expect(mergeCovered([entry({ ruleIds: null })], [entry({ ruleIds: ['a'] })])).toEqual([entry({ ruleIds: null })]);
    });

    it('keeps entries apart that differ in category, tenant or path', () => {
      const merged = mergeCovered([entry()], [entry({ category: 'cost' }), entry({ tenantId: 't2' }), entry({ path: '/subscriptions/s1' })]);
      expect(merged).toHaveLength(4);
    });
  });
});

describe('the record lock', () => {
  it('is a number of its own, declared by the module', () => {
    expect(Number.isSafeInteger(TREND_RECORD_LOCK_KEY)).toBe(true);
  });
});

describe('the access filter on trend cells', () => {
  it('matches a cell the way it matches a finding', async () => {
    await insertFinding({ ruleId: RULE_A, subscriptionId: 'sub-1', resourceGroup: 'rg-1' });
    await insertFinding({ ruleId: RULE_A, subscriptionId: 'sub-1', resourceGroup: 'rg-2' });
    await insertFinding({ ruleId: RULE_A, subscriptionId: 'sub-2', resourceGroup: 'rg-1' });
    await recount(DAY_1);

    const viewerAt = (path: string) => buildAccess([{ tenantId: '', scope: parseScope(path)!, role: 'viewer' }], 'manual');
    const seen = async (path: string) => (await many(db.select().from(trendCells).where(accessFilterSql(viewerAt(path), trendCells))))
      .map(c => `${c.subscriptionId}/${c.resourceGroup}`).sort();

    expect(await seen('/subscriptions/SUB-1')).toEqual(['sub-1/rg-1', 'sub-1/rg-2']);
    expect(await seen('/subscriptions/sub-1/resourceGroups/RG-2')).toEqual(['sub-1/rg-2']);
    expect(await seen('/subscriptions/sub-3')).toEqual([]);
  });
});

describe.runIf(process.env.RULEBEAT_TEST_PG_URL)('the Postgres start', () => {
  const dataDir = join(resolve(__dirname, '..', '..'), 'data');
  const start = () => seedPg(pgDb!, dataDir, { skipOwnerBootstrap: true, now: DAY_1 });
  const counts = async () => [
    (await many(db.select().from(trendRuleFacts))).length,
    (await many(db.select().from(trendCells))).length,
    (await many(db.select().from(trendRecordedDays))).length,
  ];

  it('records every rule, its non-zero cells and the first marker, and writes nothing on the next start', async () => {
    await dbReady;
    await resetDb();
    const [{ id: ruleId, kind }] = await many(db.select({ id: rulesTable.id, kind: rulesTable.kind }).from(rulesTable).limit(1));
    expect(kind).toBe('state');
    await insertFinding({ ruleId: ruleId! });

    await start();

    const ruleCount = (await many(db.select({ id: rulesTable.id }).from(rulesTable))).length;
    const first = await counts();
    expect(first).toEqual([ruleCount, 1, 1]);
    expect((await many(db.select().from(trendCells)))[0]!.changedAt).toBe(DAY_1.toISOString());

    await start();
    expect(await counts()).toEqual(first);
  });
});
