/**
 * Scans write the trend record (ADR 0012), in the sync's own transaction. Driven through the highest seams:
 * `runCategoryScan()` and `executeTarget()` over the fake Azure context for the scan path, and
 * `backfillFindings()` over stored scans for the one-time rebuild, then read back through the record's own
 * tables and a recount. The record write is wrapped (not replaced) so a test can make it fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq, like, or } from 'drizzle-orm';
import { computeFingerprint } from '@rulebeat/core';
import { dbKind } from '@/lib/db/backend';
import { db } from '@/lib/db/client';
import { inTransaction, many, run as execRun } from '@/lib/db/exec';
import {
  findings as findingsTable, meta, rules as rulesTable, scans as scansTable, trendCells, trendRecordedDays, trendRuleFacts,
} from '@/lib/db/tables';
import { backfillFindings, syncScanFindings } from '@/lib/db/findings';
import { FINDINGS_BACKFILL_MARKER } from '@/lib/db/scan-findings-copy';
import { recountTrend, type CoveredEntry } from '@/lib/db/trend-record';
import * as trendRecord from '@/lib/db/trend-record';
import { getCategory } from '@/lib/db/categories';
import { executeTarget } from '@/lib/run-executor';
import { runCategoryScan } from '@/lib/scan-runner';
import { buildAccess, parseScope } from '@/lib/access-model';
import type { Finding } from '@/lib/types';
import { clearRules, resetDb } from '../helpers/db';
import { argRow, fakeTenantContext } from '../helpers/fake-azure';
import { EVERYTHING_ACCESS } from '../helpers/access';

// The real record write, which a test can make fail once. Everything else in the module is the real thing.
vi.mock('@/lib/db/trend-record', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/trend-record')>();
  return { ...actual, recountTrend: vi.fn(actual.recountTrend) };
});

const CATEGORY = 'identity';
const RULE_A = 'scan-trend-rule-a';
const RULE_B = 'scan-trend-rule-b';
const ARG_KQL = 'resources | where type == "microsoft.compute/virtualmachines"';
const VM_ONE = argRow({ name: 'vm-one' });
const VM_TWO = argRow({ name: 'vm-two', resourceGroup: 'rg-other' });

// Today at midnight UTC, so the dates are inside the event retention window and on one UTC day.
const MIDNIGHT = new Date().setUTCHours(0, 0, 0, 0);
const at = (hour: number) => new Date(MIDNIGHT + hour * 3_600_000);
const DAY = new Date(MIDNIGHT).toISOString().slice(0, 10);

async function insertRule(id: string, extra: Record<string, unknown> = {}): Promise<void> {
  await execRun(db.delete(rulesTable).where(eq(rulesTable.id, id)));
  await execRun(db.insert(rulesTable).values({
    id, name: id, description: 'test rule', category: CATEGORY, severity: 'medium', enabled: true,
    scope: JSON.stringify({ level: 'subscription' }), resourceTypes: '[]', conditions: '[]',
    rawKql: `${ARG_KQL} | where tags.rule == "${id}"`, type: 'custom', ...extra,
  }));
}

/** A fake Azure that answers each rule's query with the rows named for it, and throws for a rule named in `failing`. */
function ctxFor(rowsByRule: Record<string, Record<string, unknown>[]>, failing: string[] = []) {
  return fakeTenantContext({
    rows: (kql) => {
      const id = Object.keys(rowsByRule).find(rule => kql.includes(`"${rule}"`));
      if (!id) throw new Error(`no rows registered for ${kql}`);
      if (failing.includes(id)) throw new Error('429 Too Many Requests');
      return rowsByRule[id]!;
    },
  });
}

const scan = async (hour: number, rowsByRule: Record<string, Record<string, unknown>[]>, opts: { ruleIds?: string[]; failing?: string[] } = {}) =>
  runCategoryScan((await getCategory(CATEGORY))!, {
    access: EVERYTHING_ACCESS, ctx: ctxFor(rowsByRule, opts.failing), ruleIds: opts.ruleIds, now: at(hour),
  });

const cells = () => many(db.select().from(trendCells).orderBy(asc(trendCells.seq)));
const facts = () => many(db.select().from(trendRuleFacts).orderBy(asc(trendRuleFacts.seq)));
const days = () => many(db.select().from(trendRecordedDays).orderBy(asc(trendRecordedDays.day)));
const coverageOf = async (day = DAY): Promise<CoveredEntry[]> => {
  const row = (await days()).find(d => d.day === day);
  return row ? JSON.parse(row.covered) as CoveredEntry[] : [];
};
const recount = (now: Date) => inTransaction(tx => recountTrend(tx, { now }));
const forAnyone = (e: Partial<CoveredEntry>): CoveredEntry => ({ category: CATEGORY, tenantId: '', path: null, ruleIds: null, ...e });

beforeEach(async () => {
  await resetDb();
  await clearRules();
  await insertRule(RULE_A);
  await insertRule(RULE_B);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('a scan writes the trend record', () => {
  it('records created, resolved and re-graded findings as cells dated at the scan\'s finish, and the rule facts', async () => {
    await scan(1, { [RULE_A]: [VM_ONE, VM_TWO], [RULE_B]: [] });

    expect((await cells()).map(c => [c.ruleId, c.resourceGroup, c.severity, c.openCount, c.changedAt]).sort()).toEqual([
      [RULE_A, 'rg-other', 'medium', 1, at(1).toISOString()],
      [RULE_A, 'rg-test', 'medium', 1, at(1).toISOString()],
    ]);
    expect((await facts()).map(f => [f.ruleId, f.lastRunStatus, f.changedAt]).sort()).toEqual([
      [RULE_A, 'success', at(1).toISOString()],
      [RULE_B, 'success', at(1).toISOString()],
    ]);

    // vm-two is fixed and the rule is re-graded: the cell goes to 0 and the new severity gets its own cell.
    await execRun(db.update(rulesTable).set({ severity: 'high' }).where(eq(rulesTable.id, RULE_A)));
    await scan(3, { [RULE_A]: [VM_ONE], [RULE_B]: [] });

    const newest = new Map<string, number>();
    for (const c of await cells()) newest.set(`${c.resourceGroup}/${c.severity}`, c.openCount);
    expect(newest.get('rg-other/medium')).toBe(0);
    expect((await cells()).filter(c => c.changedAt === at(3).toISOString())).not.toHaveLength(0);
  });

  it('writes a rule\'s last-run status in the same transaction as its cells, so they cannot disagree', async () => {
    await scan(1, { [RULE_A]: [VM_ONE], [RULE_B]: [] });
    await scan(2, { [RULE_A]: [], [RULE_B]: [] }, { failing: [RULE_A] });

    const [failed] = (await facts()).filter(f => f.ruleId === RULE_A && f.lastRunStatus === 'failed');
    expect(failed, 'the failed run was not recorded as a fact').toBeDefined();
    // The failed rule's findings were not resolved, and the record still counts them.
    const newestCell = (await cells()).filter(c => c.ruleId === RULE_A).at(-1)!;
    expect(newestCell.openCount).toBe(1);
  });

  it('leaves a recount nothing to write after a full scan and after a targeted one', async () => {
    await scan(1, { [RULE_A]: [VM_ONE], [RULE_B]: [VM_TWO] });
    expect(await recount(at(2))).toEqual({ cells: 0, facts: 0 });

    await scan(3, { [RULE_A]: [], [RULE_B]: [VM_TWO] }, { ruleIds: [RULE_A] });
    expect(await recount(at(4))).toEqual({ cells: 0, facts: 0 });
  });

  it('adds each scan\'s coverage to the day\'s marker, merged: the union of rule ids, with null absorbing', async () => {
    await scan(1, { [RULE_A]: [], [RULE_B]: [] }, { ruleIds: [RULE_A] });
    expect(await coverageOf()).toEqual([forAnyone({ ruleIds: [RULE_A] })]);

    await scan(2, { [RULE_A]: [], [RULE_B]: [] }, { ruleIds: [RULE_B] });
    expect(await coverageOf()).toEqual([forAnyone({ ruleIds: [RULE_A, RULE_B] })]);

    await scan(3, { [RULE_A]: [], [RULE_B]: [] });
    expect(await coverageOf()).toEqual([forAnyone({ ruleIds: null })]);

    await scan(4, { [RULE_A]: [], [RULE_B]: [] }, { ruleIds: [RULE_A] });
    expect(await coverageOf()).toEqual([forAnyone({ ruleIds: null })]);
  });

  it('keeps a scope\'s path and tenant in the coverage it adds', async () => {
    const sub = '/subscriptions/11111111-1111-1111-1111-111111111111';
    const editor = buildAccess([{ tenantId: 'tenant-1', scope: parseScope(sub)!, role: 'editor' }], 'manual');
    await runCategoryScan((await getCategory(CATEGORY))!, { access: editor, ctx: ctxFor({ [RULE_A]: [], [RULE_B]: [] }), now: at(1) });

    expect(await coverageOf()).toEqual([forAnyone({ tenantId: 'tenant-1', path: sub })]);
  });

  it('adds coverage for a partial scan', async () => {
    const outcome = await scan(1, { [RULE_A]: [VM_ONE], [RULE_B]: [] }, { failing: [RULE_B] });

    expect(outcome.summary.coverage).toBe('partial');
    expect(await coverageOf()).toEqual([forAnyone({ ruleIds: null })]);
  });

  it('adds no coverage for a scan that errored', async () => {
    vi.mocked(trendRecord.recountTrend).mockRejectedValueOnce(new Error('connection lost'));

    await expect(scan(1, { [RULE_A]: [VM_ONE], [RULE_B]: [] })).rejects.toThrow();

    expect(await coverageOf()).toEqual([]);
  });

  it('writes no coverage when it is a sync made outside a scan', async () => {
    await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [], finishedAt: at(1).toISOString() });

    expect(await coverageOf()).toEqual([]);
    expect((await days()).map(d => d.day)).toEqual([DAY]);
  });
});

describe('a failed record write fails the scan', () => {
  const COPY = 'Trend history could not be recorded, so this scan\'s results were not saved.';

  it('leaves no findings change and no saved scan, marks the run failed, and says why in Run History', async () => {
    await scan(1, { [RULE_A]: [VM_ONE], [RULE_B]: [] });
    const findingsBefore = await many(db.select().from(findingsTable).orderBy(asc(findingsTable.fingerprint)));
    const scansBefore = (await many(db.select({ id: scansTable.id }).from(scansTable))).length;
    const cellsBefore = await cells();
    const ruleBefore = (await many(db.select().from(rulesTable).where(eq(rulesTable.id, RULE_A))))[0]!;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(trendRecord.recountTrend).mockRejectedValueOnce(new Error('disk full'));

    // vm-two appears and vm-one goes: all of it must be rolled back.
    const run = await executeTarget(
      { targetType: 'categories', targetValues: [CATEGORY] },
      { access: EVERYTHING_ACCESS, triggeredBy: 'manual', ctx: ctxFor({ [RULE_A]: [VM_TWO], [RULE_B]: [] }), now: at(2) },
    );

    expect(run.status).toBe('error');
    expect(run.error).toContain(COPY);
    expect(run.error).not.toContain('disk full');
    expect(await many(db.select().from(findingsTable).orderBy(asc(findingsTable.fingerprint)))).toEqual(findingsBefore);
    expect((await many(db.select({ id: scansTable.id }).from(scansTable))).length).toBe(scansBefore);
    expect(await cells()).toEqual(cellsBefore);
    expect((await many(db.select().from(rulesTable).where(eq(rulesTable.id, RULE_A))))[0]).toEqual(ruleBefore);
  });

  it('scans normally on the next run', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(trendRecord.recountTrend).mockRejectedValueOnce(new Error('disk full'));
    const target = { targetType: 'categories' as const, targetValues: [CATEGORY] };
    await executeTarget(target, { access: EVERYTHING_ACCESS, triggeredBy: 'manual', ctx: ctxFor({ [RULE_A]: [VM_ONE], [RULE_B]: [] }), now: at(1) });

    const run = await executeTarget(target, { access: EVERYTHING_ACCESS, triggeredBy: 'manual', ctx: ctxFor({ [RULE_A]: [VM_ONE], [RULE_B]: [] }), now: at(2) });

    expect(run.status).toBe('success');
    expect((await cells()).map(c => c.openCount)).toEqual([1]);
  });
});

/**
 * Two writers touching one key. On Postgres the sync's transactions run side by side and meet only at the record
 * lock, so this is the proof the lock is taken last: each sync is held just before its recount until both have got
 * there. A lock taken at the start of the sync keeps the second one out of its own writes, so the two never meet.
 */
describe.runIf(dbKind === 'pg')('two syncs touching one key at once', () => {
  it('both end correct, because the record lock is taken just before the recount', async () => {
    const realRecount = (await vi.importActual<typeof import('@/lib/db/trend-record')>('@/lib/db/trend-record')).recountTrend;
    let arrived = 0;
    // For each sync, how many had reached the recount when it was let through. Two means the syncs met there.
    const arrivedWhenLetThrough: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(trendRecord.recountTrend).mockImplementation(async (tx, opts) => {
      if (++arrived === 2) release();
      await Promise.race([gate, new Promise(resolve => setTimeout(resolve, 3000))]);
      arrivedWhenLetThrough.push(arrived);
      return realRecount(tx, opts);
    });
    const finding = (name: string): Finding => {
      const row = argRow({ name });
      const resourceId = String(row.id);
      return {
        module: CATEGORY, ruleId: RULE_A, fingerprint: computeFingerprint(RULE_A, resourceId), severity: 'medium', category: CATEGORY,
        resourceId, resourceType: 'microsoft.compute/virtualmachines', resourceName: name, subscriptionId: String(row.subscriptionId),
        resourceGroup: 'rg-test', title: 't', description: 'd', evidence: {}, rows: [{}], detectedAt: at(1).toISOString(),
      } as unknown as Finding;
    };
    const sync = (id: string, f: Finding) => syncScanFindings({
      scanId: id, category: CATEGORY, ranRuleIds: [], findings: [f], finishedAt: at(1).toISOString(),
    });

    try {
      await Promise.all([sync('s1', finding('vm-one')), sync('s2', finding('vm-two'))]);
    } finally {
      vi.mocked(trendRecord.recountTrend).mockImplementation(realRecount);
    }

    expect(arrivedWhenLetThrough, 'a sync was let through its recount before the other had reached its own').toEqual([2, 2]);
    expect((await cells()).at(-1)!.openCount).toBe(2);
    expect(await recount(at(2))).toEqual({ cells: 0, facts: 0 });
  });
});

/** The one-time findings rebuild replays old scans: it observed nothing, so it records nothing of them. */
describe('the one-time findings backfill', () => {
  const storeOldScan = (id: string, hour: number, rows: Record<string, unknown>[]) => execRun(db.insert(scansTable).values({
    id, module: CATEGORY, startedAt: at(hour).toISOString(), finishedAt: at(hour).toISOString(), durationMs: 10,
    subscriptionsScanned: '[]', counts: '{}', totalRules: 1,
    findings: JSON.stringify(rows.map(row => ({
      ruleId: RULE_A, fingerprint: computeFingerprint(RULE_A, String(row.id)), severity: 'medium', category: CATEGORY,
      resourceId: String(row.id), resourceType: 'microsoft.compute/virtualmachines', resourceName: String(row.name),
      subscriptionId: String(row.subscriptionId), resourceGroup: String(row.resourceGroup), title: 't', description: 'd',
      recommendation: 'r', evidence: {},
    }))),
  }));

  beforeEach(async () => {
    // `resetDb()` keeps `meta`, so the marker of the whole rebuild and of each category is cleared here.
    await execRun(db.delete(meta).where(or(eq(meta.key, FINDINGS_BACKFILL_MARKER), like(meta.key, `${FINDINGS_BACKFILL_MARKER}:%`))));
    await execRun(db.delete(rulesTable).where(eq(rulesTable.id, RULE_B)));
    await storeOldScan('old-1', -48, [VM_ONE, VM_TWO]);
    await storeOldScan('old-2', -24, [VM_ONE]);
  });

  it('leaves no record row dated before now, the record at now equal to live, and nothing for a later recount to write', async () => {
    const before = new Date();

    await backfillFindings();

    const live = await many(db.select().from(findingsTable));
    expect(live.filter(f => f.status === 'active').map(f => f.resourceName)).toEqual(['vm-one']);
    expect((await cells()).length).toBeGreaterThan(0);
    for (const row of [...await cells(), ...await facts()]) {
      expect(row.changedAt >= before.toISOString(), `a record row was dated ${row.changedAt}, before the backfill ran`).toBe(true);
    }
    expect((await cells()).filter(c => c.openCount > 0).map(c => [c.resourceGroup, c.openCount])).toEqual([['rg-test', 1]]);
    expect(await recount(new Date())).toEqual({ cells: 0, facts: 0 });
  });

  it('writes today\'s marker only and adds no covered scope', async () => {
    await backfillFindings();

    expect((await days()).map(d => [d.day, d.covered])).toEqual([[new Date().toISOString().slice(0, 10), '[]']]);
  });
});
