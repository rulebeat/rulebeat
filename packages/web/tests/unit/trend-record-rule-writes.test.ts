/**
 * Rule writes record their facts and cells (ADR 0012). Each rule-side posture input is performed through its
 * public function, with an injected clock, and the assertions are on the trend record it left and on a full
 * recount writing nothing afterwards: if the input's own write were missing, the recount would find the rows
 * it should have found. The route behaviour of a failed record write is trend-record-rule-routes.test.ts; the
 * Postgres lock order is the last block here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { join, resolve } from 'node:path';
import type { Rule } from '@rulebeat/core';
import { db, dbReady, pgDb, rawSqlite } from '@/lib/db/client';
import { inTransaction, many, run } from '@/lib/db/exec';
import { findings as findingsTable, rules as rulesTable, trendCells, trendRuleFacts } from '@/lib/db/tables';
import { runSeeds } from '@/lib/db/migrate';
import { seedPg } from '@/lib/db/pg/seeds';
import { recountTrend } from '@/lib/db/trend-record';
import { deleteFindingsForRule } from '@/lib/db/findings';
import { createUser } from '@/lib/db/users';
import { createPersonalRule, type PersonalRuleDefinition } from '@/lib/db/personal-rules';
import { approveLibraryRequest, createLibraryRequest } from '@/lib/db/library-requests';
import {
  createRule, deleteRule, duplicateRule, loadRule, setRulesEnabled, setRulesEnabledBulk, switchRuleVersion, updateRule,
} from '@/lib/rules';
import type { ShippedCatalogue } from '@/lib/shipped-catalogue';
import { catalogueOf, shippedRule } from '../helpers/catalogue';
import { clearRules, resetDb } from '../helpers/db';

const dataDir = join(resolve(__dirname, '..', '..'), 'data');
const KQL = 'resources | where type =~ "microsoft.compute/virtualmachines" | project id, name, type, location, resourceGroup, subscriptionId';
const T0 = new Date('2026-03-09T08:00:00.000Z');
const T1 = new Date('2026-03-10T09:00:00.000Z');
const T2 = new Date('2026-03-11T10:30:00.000Z');
const T3 = new Date('2026-03-12T11:45:00.000Z');

let counter = 0;
const uniq = (label: string) => `${label} ${++counter} ${Math.random().toString(36).slice(2)}`;

function ruleBody(over: Partial<Rule> = {}): Rule {
  return {
    id: globalThis.crypto.randomUUID(), name: uniq('rule'), description: 'a test rule', category: 'security', severity: 'high',
    enabled: true, type: 'custom', scope: { level: 'subscription' }, resourceTypes: [], conditions: [], rawKql: KQL,
    queryBackend: 'resource-graph', kind: 'state', ...over,
  };
}

async function insertFinding(ruleId: string, over: Partial<typeof findingsTable.$inferInsert> = {}): Promise<void> {
  await run(db.insert(findingsTable).values({
    fingerprint: uniq('fp'), ruleId, category: 'security', severity: 'high', kind: 'state', subscriptionId: 'sub-1', resourceGroup: 'rg-1',
    placement: 'resource', title: 't', status: 'active', firstSeenAt: '2026-03-01T00:00:00.000Z', lastSeenAt: '2026-03-01T00:00:00.000Z',
    ...over,
  }));
}

const factsOf = (ruleId: string) => many(db.select().from(trendRuleFacts).where(eq(trendRuleFacts.ruleId, ruleId)).orderBy(asc(trendRuleFacts.seq)));
const cellsOf = (ruleId: string) => many(db.select().from(trendCells).where(eq(trendCells.ruleId, ruleId)).orderBy(asc(trendCells.seq)));
const recount = (now: Date) => inTransaction(tx => recountTrend(tx, { now }));

/** The record agrees with the rules and findings: a recount of everything has nothing to write. */
async function expectRecordComplete(): Promise<void> {
  expect(await recount(new Date('2026-04-01T00:00:00.000Z'))).toEqual({ cells: 0, facts: 0 });
}

/** A custom rule created at T0, with two open findings recorded at T1. */
async function ruleWithFindings(over: Partial<Rule> = {}): Promise<Rule> {
  const rule = ruleBody(over);
  const created = await createRule(rule, { now: T0 });
  if (!created.ok) throw new Error('could not create the rule');
  await insertFinding(rule.id);
  await insertFinding(rule.id);
  await recount(T1);
  expect(await cellsOf(rule.id)).toMatchObject([{ openCount: 2, changedAt: T1.toISOString() }]);
  return rule;
}

beforeEach(async () => {
  await resetDb();
  await clearRules();
});

describe('creating a rule', () => {
  it('writes its fact row dated by the clock, and a recount after it writes nothing', async () => {
    const rule = ruleBody({ enabled: false, severity: 'low', scope: { level: 'subscription', subscriptions: ['sub-1'] } });

    await createRule(rule, { now: T0 });

    expect(await factsOf(rule.id)).toMatchObject([{
      ruleId: rule.id, changedAt: T0.toISOString(), enabled: false, kind: 'state', severity: 'low',
      scope: JSON.stringify(rule.scope), runningVersion: null, lastRunStatus: null, deleted: false,
    }]);
    await expectRecordComplete();
  });

  it('writes nothing when the name is taken', async () => {
    const rule = ruleBody();
    await createRule(rule, { now: T0 });

    const clash = await createRule(ruleBody({ name: rule.name.toUpperCase() }), { now: T1 });

    expect(clash).toEqual({ ok: false, reason: 'name-taken' });
    expect(await many(db.select().from(trendRuleFacts))).toHaveLength(1);
  });
});

describe('updating a rule', () => {
  it.each([
    ['enabled', { enabled: false }, { enabled: false }],
    ['severity', { severity: 'low' as const }, { severity: 'low' }],
    ['scope', { scope: { level: 'subscription' as const, subscriptions: ['sub-9'] } }, { scope: JSON.stringify({ level: 'subscription', subscriptions: ['sub-9'] }) }],
  ])('writes a fact row when %s changes, and a recount after it writes nothing', async (_name, changes, expected) => {
    const rule = ruleBody();
    await createRule(rule, { now: T0 });

    await updateRule(rule.id, changes, { now: T1 });

    const facts = await factsOf(rule.id);
    expect(facts).toHaveLength(2);
    expect(facts[1]).toMatchObject({ changedAt: T1.toISOString(), ...expected });
    await expectRecordComplete();
  });

  it('writes no fact row for a change that is not a fact, such as the name or the description', async () => {
    const rule = ruleBody();
    await createRule(rule, { now: T0 });

    await updateRule(rule.id, { name: uniq('renamed'), description: 'another' }, { now: T1 });

    expect(await factsOf(rule.id)).toHaveLength(1);
    await expectRecordComplete();
  });

  it('writes the fact and takes the rule\'s cells to 0 when a Problem rule becomes an Advisory, dated at the switch', async () => {
    const rule = await ruleWithFindings();

    await updateRule(rule.id, { kind: 'advisory' }, { now: T2 });

    const facts = await factsOf(rule.id);
    expect(facts.map(f => [f.kind, f.changedAt])).toEqual([['state', T0.toISOString()], ['advisory', T2.toISOString()]]);
    expect((await cellsOf(rule.id)).map(c => [c.openCount, c.suppressedCount, c.changedAt])).toEqual([
      [2, 0, T1.toISOString()],
      [0, 0, T2.toISOString()],
    ]);
    await expectRecordComplete();
  });

  it('counts the findings again when an Advisory becomes a Problem rule', async () => {
    const rule = await ruleWithFindings({ kind: 'state' });
    await updateRule(rule.id, { kind: 'advisory' }, { now: T2 });

    await updateRule(rule.id, { kind: 'state' }, { now: T3 });

    expect((await cellsOf(rule.id)).map(c => [c.openCount, c.changedAt])).toEqual([
      [2, T1.toISOString()], [0, T2.toISOString()], [2, T3.toISOString()],
    ]);
    await expectRecordComplete();
  });
});

describe('duplicating a rule', () => {
  it('writes the copy\'s fact row, disabled, dated by the clock', async () => {
    const rule = await ruleWithFindings();

    const copy = await duplicateRule(rule.id, { now: T2 });

    expect(await factsOf(copy!.id)).toMatchObject([{ changedAt: T2.toISOString(), enabled: false, severity: 'high', kind: 'state' }]);
    expect(await cellsOf(copy!.id)).toEqual([]);
    await expectRecordComplete();
  });
});

describe('deleting a rule', () => {
  it('writes its cells down to 0 and a deletion fact that keeps the five last labels', async () => {
    const rule = await ruleWithFindings({ tags: ['prod', 'vm'], category: 'security' });

    expect(await deleteRule(rule.id, { now: T2 })).toBe(true);

    const facts = await factsOf(rule.id);
    expect(facts).toHaveLength(2);
    expect(facts[1]).toMatchObject({
      deleted: true, changedAt: T2.toISOString(), lastName: rule.name, lastCategory: 'security',
      lastCategoryLabel: 'Security', lastTags: JSON.stringify(['prod', 'vm']), lastSource: 'custom',
    });
    expect(facts[0]).toMatchObject({ deleted: false, lastName: null });
    expect((await cellsOf(rule.id)).map(c => [c.openCount, c.suppressedCount, c.changedAt])).toEqual([
      [2, 0, T1.toISOString()], [0, 0, T2.toISOString()],
    ]);
    expect(await loadRule(rule.id)).toBeNull();
    await expectRecordComplete();
  });

  it('keeps nothing of a rule that does not exist', async () => {
    expect(await deleteRule('no-such-rule', { now: T2 })).toBe(false);
    expect(await many(db.select().from(trendRuleFacts))).toEqual([]);
  });
});

describe('clearing a rule\'s findings', () => {
  it('takes the rule\'s cells to 0 at the time of the clear and keeps the earlier row, and the rule\'s facts stand', async () => {
    const rule = await ruleWithFindings();

    expect(await deleteFindingsForRule(rule.id, { now: T2 })).toBe(2);

    expect((await cellsOf(rule.id)).map(c => [c.openCount, c.changedAt])).toEqual([[2, T1.toISOString()], [0, T2.toISOString()]]);
    expect(await factsOf(rule.id)).toHaveLength(1);
    await expectRecordComplete();
  });
});

describe('bulk enable and disable', () => {
  it('dates the fact rows of both lists by the injected clock, in one transaction, and a recount after it writes nothing', async () => {
    const [a, b, c] = [ruleBody({ enabled: false }), ruleBody({ enabled: true }), ruleBody({ enabled: true })];
    for (const rule of [a, b, c]) await createRule(rule, { now: T0 });

    const result = await setRulesEnabledBulk([a.id, 'gone'], [b.id], { now: T2 });

    expect(result.enabled).toEqual({ updatedIds: [a.id], notFoundIds: ['gone'] });
    expect(result.disabled).toEqual({ updatedIds: [b.id], notFoundIds: [] });
    expect((await factsOf(a.id)).map(f => [f.enabled, f.changedAt])).toEqual([[false, T0.toISOString()], [true, T2.toISOString()]]);
    expect((await factsOf(b.id)).map(f => [f.enabled, f.changedAt])).toEqual([[true, T0.toISOString()], [false, T2.toISOString()]]);
    expect(await factsOf(c.id)).toHaveLength(1);
    await expectRecordComplete();
  });

  it('writes nothing for a rule already in the asked state', async () => {
    const rule = ruleBody({ enabled: true });
    await createRule(rule, { now: T0 });

    await setRulesEnabled([rule.id], true, { now: T2 });

    expect(await factsOf(rule.id)).toHaveLength(1);
  });
});

describe('switching a rule version', () => {
  const ID = 'aaaaaaaa-0000-4000-8000-0000000000c1';
  const v1 = shippedRule({ id: ID, definition: { name: 'Versioned rule', severity: 'medium' } });
  const v2 = shippedRule({ id: ID, version: '2.0.0', definition: { name: 'Versioned rule', severity: 'critical', kind: 'advisory' } });

  async function seed(catalogue: ShippedCatalogue, now: Date): Promise<void> {
    await dbReady;
    if (pgDb) await seedPg(pgDb, dataDir, { skipOwnerBootstrap: true, catalogue, now });
    else runSeeds(rawSqlite!, dataDir, { skipOwnerBootstrap: true, catalogue, now });
  }

  it('writes the running version and what the version changed, takes the cells of a rule that became an Advisory to 0, and a recount writes nothing', async () => {
    await seed(catalogueOf(v1), T0);
    await seed(catalogueOf(v2), T0);
    await run(db.update(rulesTable).set({ enabled: true }).where(eq(rulesTable.id, ID)));
    await insertFinding(ID);
    await recount(T1);
    expect((await cellsOf(ID)).map(c => c.openCount)).toEqual([1]);

    const result = await switchRuleVersion(ID, '2.0.0', { now: T2 });

    expect(result.ok).toBe(true);
    const facts = await factsOf(ID);
    expect(facts.at(-1)).toMatchObject({ changedAt: T2.toISOString(), runningVersion: '2.0.0', severity: 'critical', kind: 'advisory' });
    expect((await cellsOf(ID)).map(c => [c.openCount, c.changedAt])).toEqual([[1, T1.toISOString()], [0, T2.toISOString()]]);
    await expectRecordComplete();
  });

  it('writes nothing when the version is unknown', async () => {
    await seed(catalogueOf(v1), T0);
    const before = (await many(db.select().from(trendRuleFacts))).length;

    expect(await switchRuleVersion(ID, '9.9.9', { now: T2 })).toEqual({ ok: false, reason: 'unknown-version' });

    expect(await many(db.select().from(trendRuleFacts))).toHaveLength(before);
  });
});

describe('approving a Library request', () => {
  const definition = (over: Partial<PersonalRuleDefinition> = {}): PersonalRuleDefinition => ({
    name: uniq('requested'), description: 'd', category: 'security', severity: 'high', queryBackend: 'resource-graph', kind: 'state',
    tags: [], scope: { level: 'subscription', subscriptions: ['sub-1'] }, resourceTypes: [], conditions: [], rawKql: KQL, ...over,
  });
  async function author(): Promise<string> {
    const created = await createUser({ email: `author-${Math.random().toString(36).slice(2)}@example.com`, role: 'admin' });
    if ('error' in created) throw new Error(created.error);
    return created.user.id;
  }

  it('writes the fact row of the rule a new-rule request creates, dated by the clock', async () => {
    const authorId = await author();
    const personal = await createPersonalRule(authorId, definition());
    const created = await createLibraryRequest(personal, authorId);
    if (!created.ok) throw new Error('could not send');

    const approved = await approveLibraryRequest(created.request.id, authorId, { enabled: true }, { now: T2 });

    if (!approved.ok) throw new Error('could not approve');
    expect(await factsOf(approved.rule.id)).toMatchObject([{ changedAt: T2.toISOString(), enabled: true, severity: 'high', kind: 'state' }]);
    await expectRecordComplete();
  });

  it('writes the facts and cells an update request changes on its target', async () => {
    const authorId = await author();
    const target = await ruleWithFindings();
    const personal = await createPersonalRule(authorId, definition({ name: target.name, kind: 'advisory', severity: 'low', rawKql: target.rawKql }));
    const created = await createLibraryRequest(personal, authorId, undefined, target.id);
    if (!created.ok) throw new Error('could not send');

    const approved = await approveLibraryRequest(created.request.id, authorId, {}, { now: T2 });

    expect(approved.ok).toBe(true);
    expect((await factsOf(target.id)).at(-1)).toMatchObject({ changedAt: T2.toISOString(), kind: 'advisory', severity: 'low' });
    expect((await cellsOf(target.id)).map(c => [c.openCount, c.changedAt])).toEqual([[2, T1.toISOString()], [0, T2.toISOString()]]);
    await expectRecordComplete();
  });
});

describe('startup seeding', () => {
  const ID = 'aaaaaaaa-0000-4000-8000-0000000000d1';
  const OTHER = 'aaaaaaaa-0000-4000-8000-0000000000d2';
  const APRL_VERSION = '2026-06-08T13:06:47Z';

  async function seed(catalogue: ShippedCatalogue, now: Date): Promise<void> {
    await dbReady;
    if (pgDb) await seedPg(pgDb, dataDir, { skipOwnerBootstrap: true, catalogue, now });
    else runSeeds(rawSqlite!, dataDir, { skipOwnerBootstrap: true, catalogue, now });
  }

  /** What the start recount would say if the seeding had left the record behind. */
  const startCorrections = (warn: { mock: { calls: unknown[][] } }) =>
    warn.mock.calls.filter(args => String(args[0]).includes('trend history: the start recount'));

  beforeEach(async () => {
    // A start before the change under test, so `trend_state` exists and the start recount reports what it corrects.
    await seed(catalogueOf(), T0);
  });

  async function seedThenExpectNoCorrection(catalogue: ShippedCatalogue, now: Date): Promise<void> {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await seed(catalogue, now);
      expect(startCorrections(warn)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
    await expectRecordComplete();
  }

  it('records a new rule', async () => {
    await seedThenExpectNoCorrection(catalogueOf(shippedRule({ id: ID, definition: { name: 'Seeded new' } })), T1);

    expect(await factsOf(ID)).toMatchObject([{ changedAt: T1.toISOString(), enabled: true, severity: 'medium', runningVersion: '1.0.0' }]);
  });

  it('records a disabled rule moving to a newer version', async () => {
    await seed(catalogueOf(shippedRule({ id: ID, enabled: false, definition: { name: 'Seeded moving' } })), T1);

    await seedThenExpectNoCorrection(catalogueOf(shippedRule({ id: ID, version: '2.0.0', definition: { name: 'Seeded moving', severity: 'critical' } })), T2);

    expect((await factsOf(ID)).at(-1)).toMatchObject({ changedAt: T2.toISOString(), runningVersion: '2.0.0', severity: 'critical', enabled: false });
  });

  it('records the built-in stored with no version taking its shipped definition and version', async () => {
    await seed(catalogueOf(shippedRule({ id: ID, definition: { name: 'Seeded unversioned', severity: 'medium' } })), T1);
    await run(db.update(rulesTable).set({ version: null, severity: 'low' }).where(eq(rulesTable.id, ID)));
    await recount(T1);

    await seedThenExpectNoCorrection(catalogueOf(shippedRule({ id: ID, definition: { name: 'Seeded unversioned', severity: 'medium' } })), T2);

    expect((await factsOf(ID)).at(-1)).toMatchObject({ changedAt: T2.toISOString(), runningVersion: '1.0.0', severity: 'medium' });
  });

  it('leaves the record as it is for a rule no pack ships any more, which keeps running', async () => {
    await seed(catalogueOf(shippedRule({ id: ID, definition: { name: 'Seeded retired' } }), shippedRule({ id: OTHER, definition: { name: 'Seeded kept' } })), T1);
    const before = await factsOf(ID);

    await seedThenExpectNoCorrection(catalogueOf(shippedRule({ id: OTHER, definition: { name: 'Seeded kept' } })), T2);

    expect((await many(db.select().from(rulesTable).where(eq(rulesTable.id, ID))))[0]!.retiredAt).not.toBeNull();
    expect(await factsOf(ID)).toEqual(before);
  });

  it('records the seed path that deletes a rule\'s findings, taking its cells to 0', async () => {
    const old = shippedRule({ id: ID, pack: 'aprl-v2', versionScheme: 'upstream-commit-date', version: APRL_VERSION, definition: { name: 'Seeded corrected', rawKql: 'Resources | where name == "wrong" | project id' } });
    await seed(catalogueOf(old), T1);
    await insertFinding(ID);
    await recount(T1);
    expect((await cellsOf(ID)).map(c => c.openCount)).toEqual([1]);

    await seedThenExpectNoCorrection(catalogueOf({ ...old, definition: { ...old.definition, rawKql: 'Resources | where name == "right" | project id' } }), T2);

    expect(await many(db.select().from(findingsTable).where(eq(findingsTable.ruleId, ID)))).toEqual([]);
    expect((await cellsOf(ID)).map(c => [c.openCount, c.changedAt])).toEqual([[1, T1.toISOString()], [0, T2.toISOString()]]);
  });
});

describe.runIf(process.env.RULEBEAT_TEST_PG_URL)('on Postgres', () => {
  it('lets a rule create race a rule update without a deadlock: the name lock is taken first and the record lock last', async () => {
    const existing = ruleBody();
    await createRule(existing, { now: T0 });

    for (let round = 0; round < 10; round++) {
      const results = await Promise.all([
        createRule(ruleBody(), { now: T1 }),
        updateRule(existing.id, { severity: round % 2 ? 'low' : 'critical' }, { now: T1 }),
        duplicateRule(existing.id, { now: T1 }),
        setRulesEnabled([existing.id], round % 2 === 0, { now: T1 }),
      ]);
      expect(results[0]).toMatchObject({ ok: true });
      expect(results[1]).toMatchObject({ ok: true });
    }

    await expectRecordComplete();
  });
});
