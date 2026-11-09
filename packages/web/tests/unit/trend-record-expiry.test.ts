/**
 * A suppression whose expiry passes is recorded (ADR 0012): at the next scheduler tick, and at the start of the
 * next record write when no scheduler runs (the Demo). The sweep recounts the rules whose suppressions expired
 * since `trend_state.swept_through` and then advances it. Driven through the real tick and the real record
 * writers with an injected clock, and checked by a full recount writing nothing afterwards.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import type { Rule } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { inTransaction, many, run } from '@/lib/db/exec';
import { findings as findingsTable, trendCells, trendState } from '@/lib/db/tables';
import { recordRecordedDay, recountTrend } from '@/lib/db/trend-record';
import { createRule, updateRule } from '@/lib/rules';
import { addSuppression } from '@/lib/suppressions';
import { tickOnce } from '@/lib/scheduler';
import type { Suppression } from '@/lib/types';
import { clearRules, resetDb } from '../helpers/db';
import { fakeHierarchy } from '../helpers/fake-hierarchy';

const KQL = 'resources | where type =~ "microsoft.compute/virtualmachines" | project id, name, type, location, resourceGroup, subscriptionId';
const T0 = new Date('2026-03-09T08:00:00.000Z');
const T1 = new Date('2026-03-10T09:00:00.000Z');
const EXPIRES = new Date('2026-03-11T00:00:00.000Z');
const BEFORE_EXPIRY = new Date('2026-03-10T23:59:00.000Z');
const T2 = new Date('2026-03-11T10:30:00.000Z');
const T3 = new Date('2026-03-12T11:45:00.000Z');

let counter = 0;
const uniq = (label: string) => `${label} ${++counter} ${Math.random().toString(36).slice(2)}`;

async function ruleWithFinding(): Promise<{ rule: Rule; fingerprint: string }> {
  const rule: Rule = {
    id: globalThis.crypto.randomUUID(), name: uniq('rule'), description: 'a test rule', category: 'security', severity: 'high',
    enabled: true, type: 'custom', scope: { level: 'subscription' }, resourceTypes: [], conditions: [], rawKql: KQL,
    queryBackend: 'resource-graph', kind: 'state',
  };
  const created = await createRule(rule, { now: T0 });
  if (!created.ok) throw new Error('could not create the rule');
  const fingerprint = uniq('fp');
  await run(db.insert(findingsTable).values({
    fingerprint, ruleId: rule.id, category: 'security', severity: 'high', kind: 'state', subscriptionId: 'sub-1', resourceGroup: 'rg-1',
    placement: 'resource', title: 't', status: 'active', firstSeenAt: '2026-03-01T00:00:00.000Z', lastSeenAt: '2026-03-01T00:00:00.000Z',
  }));
  return { rule, fingerprint };
}

/** A rule with one finding, suppressed until EXPIRES, recorded at T1, with the record running since T1. */
async function suppressedUntilExpiry(): Promise<Rule> {
  const { rule, fingerprint } = await ruleWithFinding();
  await inTransaction(tx => recountTrend(tx, { now: T1 }));
  await run(db.insert(trendState).values({ id: 1, sweptThrough: T1.toISOString(), eventsKeptSince: '2026-03-10' }));
  const s: Suppression = {
    id: globalThis.crypto.randomUUID(), fingerprint, reason: 'accepted', suppressedAt: T1.toISOString(), expiresAt: EXPIRES.toISOString(),
  };
  await addSuppression(s, { now: T1 });
  expect(await countsOf(rule.id)).toEqual([[1, 0, T1.toISOString()], [0, 1, T1.toISOString()]]);
  return rule;
}

const countsOf = async (ruleId: string) =>
  (await many(db.select().from(trendCells).where(eq(trendCells.ruleId, ruleId)).orderBy(asc(trendCells.seq))))
    .map(c => [c.openCount, c.suppressedCount, c.changedAt]);
const sweptThrough = async () => (await many(db.select().from(trendState).where(eq(trendState.id, 1))))[0]?.sweptThrough;
const tick = (now: Date) => tickOnce({ now, read: fakeHierarchy([]).read });

async function expectRecordComplete(): Promise<void> {
  expect(await inTransaction(tx => recountTrend(tx, { now: new Date('2026-04-01T00:00:00.000Z') }))).toEqual({ cells: 0, facts: 0 });
}

beforeEach(async () => {
  await resetDb();
  await clearRules();
});

describe('the scheduler tick', () => {
  it('records a suppression that expired since the last sweep, dated by the tick, and advances swept_through', async () => {
    const rule = await suppressedUntilExpiry();

    await tick(T2);

    expect(await countsOf(rule.id)).toEqual([[1, 0, T1.toISOString()], [0, 1, T1.toISOString()], [1, 0, T2.toISOString()]]);
    expect(await sweptThrough()).toBe(T2.toISOString());
    await expectRecordComplete();
  });

  it('writes nothing before the expiry, and still advances swept_through', async () => {
    const rule = await suppressedUntilExpiry();

    await tick(BEFORE_EXPIRY);

    expect(await countsOf(rule.id)).toHaveLength(2);
    expect(await sweptThrough()).toBe(BEFORE_EXPIRY.toISOString());
  });

  it('records the expiry once: the next tick finds it already swept', async () => {
    const rule = await suppressedUntilExpiry();
    await tick(T2);

    await tick(T3);

    expect(await countsOf(rule.id)).toHaveLength(3);
    expect(await sweptThrough()).toBe(T3.toISOString());
  });

  it('records an expiry that falls between two ticks that both passed before it', async () => {
    const rule = await suppressedUntilExpiry();
    await tick(BEFORE_EXPIRY);

    await tick(T2);

    expect((await countsOf(rule.id)).at(-1)).toEqual([1, 0, T2.toISOString()]);
  });

  it('never moves swept_through back when the clock steps back', async () => {
    await suppressedUntilExpiry();
    await tick(T2);

    await tick(T1);

    expect(await sweptThrough()).toBe(T2.toISOString());
  });

  it('writes nothing when the record has not started', async () => {
    const rule = await suppressedUntilExpiry();
    await run(db.delete(trendState));

    await tick(T2);

    expect(await countsOf(rule.id)).toHaveLength(2);
    expect(await many(db.select().from(trendState))).toEqual([]);
  });
});

describe('the next record write when no scheduler runs', () => {
  it('records the expiry at the start of a rule write', async () => {
    const rule = await suppressedUntilExpiry();
    const other = await createRule({ ...rule, id: globalThis.crypto.randomUUID(), name: uniq('other') }, { now: T1 });
    if (!other.ok) throw new Error('could not create');

    await updateRule(other.rule.id, { severity: 'low' }, { now: T2 });

    expect((await countsOf(rule.id)).at(-1)).toEqual([1, 0, T2.toISOString()]);
    expect(await sweptThrough()).toBe(T2.toISOString());
    await expectRecordComplete();
  });

  it('records the expiry at the start of a Recorded day write', async () => {
    const rule = await suppressedUntilExpiry();

    await inTransaction(tx => recordRecordedDay(tx, { now: T2 }));

    expect((await countsOf(rule.id)).at(-1)).toEqual([1, 0, T2.toISOString()]);
    expect(await sweptThrough()).toBe(T2.toISOString());
  });

  it('records the expiry at the start of a recount of other rules', async () => {
    const rule = await suppressedUntilExpiry();
    const { rule: other } = await ruleWithFinding();

    await inTransaction(tx => recountTrend(tx, { ruleIds: [other.id], now: T2 }));

    expect((await countsOf(rule.id)).at(-1)).toEqual([1, 0, T2.toISOString()]);
  });
});
