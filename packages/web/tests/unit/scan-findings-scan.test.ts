/**
 * Issue #216 (ADR 0008): a scan save stores one slim record per finding in `scan_findings`, in the same
 * transaction as the scan row, and since #219 stores no findings blob beside them. Driven through the highest seam:
 * runCategoryScan() over the fake Azure context, then reading the table back. Pruning, a deleted rule
 * and a rule id change are covered here too, since each is a rule about what happens to the records.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq, inArray, like, or } from 'drizzle-orm';
import { computeActivityFingerprint, computeFingerprint } from '@rulebeat/core';
import { dbKind } from '@/lib/db/backend';
import { db } from '@/lib/db/client';
import { many, run as execRun } from '@/lib/db/exec';
import { findingEvents, findings as findingsTable, meta, postureSnapshots, rules as rulesTable, scanFindings, scans as scansTable } from '@/lib/db/tables';
import { backfillFindings, listFindings } from '@/lib/db/findings';
import { backfillSnapshots } from '@/lib/db/snapshots';
import { FINDINGS_BACKFILL_MARKER, SNAPSHOTS_BACKFILL_MARKER, findingsBackfillCategoryKey } from '@/lib/db/scan-findings-copy';
import { getCategory } from '@/lib/db/categories';
import { deleteRule } from '@/lib/rules';
import { runCategoryScan } from '@/lib/scan-runner';
import { saveScanResult } from '@/lib/scan-history';
import { querySnapshot } from '@/lib/db/scan-snapshots';
import { queryCompare } from '@/lib/db/scan-compare';
import { emptySnapshotQuery } from '@/lib/snapshot-query';
import type { ScanSummary } from '@/lib/types';
import { countRows, resetDb } from '../helpers/db';
import { fakeTenantContext, argRow } from '../helpers/fake-azure';

// The retention limit is read when scan-history is first imported, so it is set before any import.
const previousLimit = vi.hoisted(() => {
  const before = process.env.SCAN_HISTORY_LIMIT;
  process.env.SCAN_HISTORY_LIMIT = '3';
  return before;
});
afterAll(() => {
  if (previousLimit === undefined) delete process.env.SCAN_HISTORY_LIMIT;
  else process.env.SCAN_HISTORY_LIMIT = previousLimit;
});

const ARG_RULE = 'test-snapshot-arg-rule';
const LOGS_RULE = 'test-snapshot-logs-rule';
const ARG_KQL = 'resources | where type == "microsoft.compute/virtualmachines"';

const VM_ONE = argRow({ name: 'vm-one' });
const VM_TWO = argRow({ name: 'vm-two', resourceGroup: 'rg-other' });

const baseRule = {
  description: 'test rule',
  category: 'identity',
  severity: 'medium',
  enabled: true,
  scope: JSON.stringify({ level: 'subscription' }),
  resourceTypes: JSON.stringify([]),
  conditions: JSON.stringify([]),
  type: 'custom',
};

async function insertRule(id: string, extra: Record<string, unknown> = {}): Promise<void> {
  await execRun(db.delete(rulesTable).where(eq(rulesTable.id, id)));
  await execRun(db.insert(rulesTable).values({ ...baseRule, id, name: id, rawKql: ARG_KQL, ...extra }));
}

async function scan(ruleIds: string[], ctxOptions: Parameters<typeof fakeTenantContext>[0], hoursFromBase = 0, at?: Date) {
  const category = (await getCategory('identity'))!;
  const outcome = await runCategoryScan(category, {
    ctx: fakeTenantContext(ctxOptions),
    ruleIds,
    now: at ?? new Date(Date.UTC(2026, 5, 1, hoursFromBase)),
  });
  const id = outcome.summary.id;
  if (!id) throw new Error('the scan was saved without an id');
  return { ...outcome, summary: { ...outcome.summary, id } };
}

const recordsOf = (scanId: string) => many(db
  .select().from(scanFindings).where(eq(scanFindings.scanId, scanId)).orderBy(asc(scanFindings.fingerprint)));

/** Both one-time markers and every per-category record of the findings rebuild. `resetDb()` keeps `meta`,
 *  so a test that runs the backfills clears them itself. */
const clearBackfillMarkers = () => execRun(db.delete(meta).where(or(
  inArray(meta.key, [FINDINGS_BACKFILL_MARKER, SNAPSHOTS_BACKFILL_MARKER]),
  like(meta.key, `${FINDINGS_BACKFILL_MARKER}:%`),
)));
const metaKeys = async () => (await many(db.select().from(meta).where(or(
  eq(meta.key, FINDINGS_BACKFILL_MARKER),
  like(meta.key, `${FINDINGS_BACKFILL_MARKER}:%`),
)))).map(r => r.key).sort();

beforeEach(async () => {
  await resetDb();
  await insertRule(ARG_RULE);
});

describe('a scan save', () => {
  it('stores one record per finding, as the scan saw it, with the count of rows it held', async () => {
    await insertRule(ARG_RULE, { severity: 'high', name: 'VM retirements' });
    const outcome = await scan([ARG_RULE], {
      rows: [
        { ...VM_ONE, retirement: 'a' }, { ...VM_TWO, retirement: 'x' }, { ...VM_ONE, retirement: 'b' }, { ...VM_ONE, retirement: 'c' },
      ],
    });
    const { summary } = outcome;
    expect(summary.findings).toHaveLength(2);

    const records = await recordsOf(summary.id);
    expect(records).toHaveLength(2);
    const vmOne = records.find(r => r.fingerprint === computeFingerprint(ARG_RULE, String(VM_ONE.id)))!;
    const finding = summary.findings.find(f => f.resourceId === String(VM_ONE.id))!;
    expect(vmOne).toEqual({
      scanId: summary.id,
      fingerprint: finding.fingerprint,
      ruleId: ARG_RULE,
      severity: 'high',
      title: finding.title,
      kind: 'state',
      category: 'identity',
      resourceId: String(VM_ONE.id),
      resourceName: 'vm-one',
      resourceType: 'microsoft.compute/virtualmachines',
      resourceGroup: 'rg-test',
      subscriptionId: String(VM_ONE.subscriptionId),
      rowCount: 3,
    });
    expect(records.find(r => r.resourceName === 'vm-two')).toMatchObject({ resourceGroup: 'rg-other', rowCount: 1 });
  });

  it('stores an Activity finding by its dimension, with no resource', async () => {
    await insertRule(LOGS_RULE, {
      rawKql: null,
      queryBackend: 'log-analytics',
      logsQuery: JSON.stringify({ kql: 'SigninLogs | where ResultType != 0', timeWindowDays: 30, dimensionKeyField: 'UserId' }),
    });
    const { summary } = await scan([LOGS_RULE], {
      logsRows: [{ UserId: 'u1', ResultType: '50126' }, { UserId: 'u1', ResultType: '50057' }],
    });

    expect(await recordsOf(summary.id)).toEqual([expect.objectContaining({
      fingerprint: computeActivityFingerprint(LOGS_RULE, 'u1'),
      kind: 'activity',
      resourceId: null,
      resourceName: null,
      resourceType: null,
      resourceGroup: null,
      rowCount: 2,
    })]);
  });

  it('is born converted and stores no findings blob, and its snapshot and compare still list what it found', async () => {
    const older = (await scan([ARG_RULE], { rows: [{ ...VM_ONE, n: 1 }] })).summary;
    const { summary } = await scan([ARG_RULE], { rows: [{ ...VM_ONE, n: 1 }, { ...VM_TWO, n: 2 }] }, 1);
    for (const saved of [older, summary]) {
      const [row] = await many(db.select().from(scansTable).where(eq(scansTable.id, saved.id)));
      expect(row!.hasRecords).toBe(1);
      expect(row!.findings).toBe('[]');
    }

    const snapshot = await querySnapshot(summary.id, emptySnapshotQuery());
    if (snapshot.status !== 'ok') throw new Error(`the snapshot answered ${snapshot.status}`);
    expect(snapshot.response.total).toBe(2);
    expect(snapshot.response.items.map(i => i.fingerprint).sort()).toEqual(summary.findings.map(f => f.fingerprint).sort());

    const compare = await queryCompare(older.id, summary.id, { side: 'added', page: 1 });
    if (compare.status !== 'ok') throw new Error(`the compare answered ${compare.status}`);
    expect(compare.response.totals).toEqual({ added: 1, fixed: 0, persisted: 1 });
    expect(compare.response.items.map(i => i.resourceName)).toEqual(['vm-two']);
  });

  // A Demo's first boot saves its scans before the one-time backfills run, and the backfills set their
  // markers only once they have. Whatever reaches them later must not read a scan saved since as one
  // that found nothing: replaying it would mark every open finding Fixed and draw a trend at 100%.
  it('is not replayed as a scan that found nothing by a backfill that runs after it', async () => {
    await scan([ARG_RULE], { rows: [VM_ONE, VM_TWO] });
    await clearBackfillMarkers();
    const active = async () => (await listFindings()).filter(f => f.status === 'active').map(f => f.resourceName).sort();
    expect(await active()).toEqual(['vm-one', 'vm-two']);
    // Without that day's trend row, a replay of the scan would draw it at 100% with nothing active.
    await execRun(db.delete(postureSnapshots));

    await backfillFindings();
    await backfillSnapshots();

    expect(await active()).toEqual(['vm-one', 'vm-two']);
    expect(await many(db.select().from(postureSnapshots).where(eq(postureSnapshots.date, '2026-06-01')))).toEqual([]);
  });

  it('stores a scan with no findings as a scan with no records', async () => {
    const { summary } = await scan([ARG_RULE], { rows: [] });
    expect(await recordsOf(summary.id)).toEqual([]);
    const [row] = await many(db.select().from(scansTable).where(eq(scansTable.id, summary.id)));
    expect(row!.hasRecords).toBe(1);
  });

  it('keeps a scan\'s records when a rule is renamed or re-graded later, and when it is deleted', async () => {
    const { summary } = await scan([ARG_RULE], { rows: [VM_ONE] });
    const before = await recordsOf(summary.id);

    await execRun(db.update(rulesTable).set({ name: 'Renamed', severity: 'low' }).where(eq(rulesTable.id, ARG_RULE)));
    expect(await recordsOf(summary.id)).toEqual(before);

    await deleteRule(ARG_RULE);
    expect(await recordsOf(summary.id)).toEqual(before);
  });

  it('stores no scan at all when its records cannot be stored', async () => {
    const { summary } = await scan([ARG_RULE], { rows: [VM_ONE] });
    const broken: ScanSummary = {
      ...summary,
      id: 'broken-scan',
      findings: [{ ...summary.findings[0]!, title: null as unknown as string }],
    };

    await expect(saveScanResult('identity', broken, { id: 'broken-scan' })).rejects.toThrow();

    expect(await many(db.select().from(scansTable).where(eq(scansTable.id, 'broken-scan')))).toEqual([]);
    expect(await recordsOf('broken-scan')).toEqual([]);
    // The scan stored before it is untouched.
    expect(await recordsOf(summary.id)).toHaveLength(1);
  });

  it('writes a scan too large for one statement as every record, and nothing twice', async () => {
    const { summary } = await scan([ARG_RULE], { rows: [VM_ONE] });
    const template = summary.findings[0]!;
    // More than one statement's worth on either backend: SQLite takes 69 records a statement and Postgres 5,000.
    const count = dbKind === 'pg' ? 5200 : 3000;
    const big: ScanSummary = {
      ...summary,
      id: 'big-scan',
      findings: Array.from({ length: count }, (_, i) => ({
        ...template,
        resourceId: `${template.resourceId}-${i}`,
        resourceName: `vm-${i}`,
        fingerprint: computeFingerprint(ARG_RULE, `${template.resourceId}-${i}`),
      })),
    };

    await saveScanResult('identity', big, { id: 'big-scan' });

    const records = await recordsOf('big-scan');
    expect(records).toHaveLength(count);
    expect(new Set(records.map(r => r.fingerprint)).size).toBe(count);
  });
});

describe('pruning beyond the retention limit', () => {
  it('deletes the oldest scans with their records, and keeps the newest scans with theirs', async () => {
    const ids: string[] = [];
    for (let hour = 0; hour < 5; hour++) {
      ids.push((await scan([ARG_RULE], { rows: [{ ...VM_ONE, n: hour }, { ...VM_TWO, n: hour }] }, hour * 24)).summary.id);
    }

    const stored = (await many(db.select({ id: scansTable.id }).from(scansTable))).map(s => s.id).sort();
    expect(stored).toEqual(ids.slice(2).sort());
    for (const id of ids.slice(0, 2)) expect(await recordsOf(id)).toEqual([]);
    for (const id of ids.slice(2)) expect(await recordsOf(id)).toHaveLength(2);
    expect(await countRows('scan_findings')).toBe(6);
  });

  it('prunes each category on its own', async () => {
    const { summary } = await scan([ARG_RULE], { rows: [VM_ONE] });
    const saveIn = async (module: string, id: string, hour: number) => saveScanResult(module, {
      ...summary,
      id,
      module,
      startedAt: new Date(Date.UTC(2026, 6, 1, hour)).toISOString(),
    }, { id });
    await saveIn('compute', 'compute-1', 0);
    for (let hour = 1; hour <= 4; hour++) await saveIn('network', `network-${hour}`, hour);

    const stored = (await many(db.select({ id: scansTable.id }).from(scansTable))).map(s => s.id).sort();
    expect(stored).toEqual([summary.id, 'compute-1', 'network-2', 'network-3', 'network-4'].sort());
    expect(await recordsOf('network-1')).toEqual([]);
    expect(await recordsOf('compute-1')).toHaveLength(1);
  });
});

/**
 * Issue #235: the findings rebuild sets its done marker only once every category is rebuilt or had
 * nothing to rebuild, and a failed category is tried again on a later start. The failure is injected
 * through the stored data: a blob that is not JSON fails the read before anything is replayed, and a
 * `null` entry fails the replay at the newest scan, after the older ones were already replayed.
 */
describe('the findings rebuild when a category fails', () => {
  // Relative to today: finding events older than their retention window are deleted as they are written.
  const midnight = new Date().setUTCHours(0, 0, 0, 0);
  const at = (day: number) => new Date(midnight - (10 - day) * 86_400_000).toISOString();
  const SEC_RULE = 'test-security-rule';
  const blobFinding = (row: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    ruleId: ARG_RULE,
    fingerprint: computeFingerprint(String(over.ruleId ?? ARG_RULE), String(row.id)),
    severity: 'medium',
    category: 'identity',
    resourceId: String(row.id),
    resourceType: 'microsoft.compute/virtualmachines',
    resourceName: String(row.name),
    subscriptionId: String(row.subscriptionId),
    title: 'VM retirements',
    description: 'd',
    recommendation: 'r',
    evidence: {},
    ...over,
  });
  const VM_THREE = argRow({ name: 'vm-three' });
  const storeOldScan = (id: string, day: number, blob: unknown) => execRun(db.insert(scansTable).values({
    id,
    module: 'identity',
    startedAt: at(day),
    finishedAt: at(day),
    durationMs: 10,
    subscriptionsScanned: '[]',
    findings: typeof blob === 'string' ? blob : JSON.stringify(blob),
    counts: '{}',
    totalRules: 1,
  }));
  const repairScan = (id: string, blob: unknown) => execRun(db.update(scansTable).set({ findings: JSON.stringify(blob) }).where(eq(scansTable.id, id)));
  const blobsOf = async () => (await many(db.select({ id: scansTable.id, findings: scansTable.findings }).from(scansTable))).sort((a, b) => a.id.localeCompare(b.id));
  const storedFindings = () => many(db.select().from(findingsTable).orderBy(asc(findingsTable.fingerprint)));
  const history = async () => (await many(db.select({
    name: findingsTable.resourceName, status: findingsTable.status, firstSeenAt: findingsTable.firstSeenAt, lastSeenAt: findingsTable.lastSeenAt,
    resolvedAt: findingsTable.resolvedAt, timesSeen: findingsTable.timesSeen,
  }).from(findingsTable))).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const events = async () => (await many(db.select({
    type: findingEvents.type, category: findingEvents.category, occurredAt: findingEvents.occurredAt,
  }).from(findingEvents))).sort((a, b) => a.type.localeCompare(b.type));

  beforeEach(async () => {
    await clearBackfillMarkers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('rebuilds nothing, sets no marker and keeps the stored scans when a failure stops it part way, then rebuilds the whole category once, as if it had not failed', async () => {
    await storeOldScan('old-1', 1, [blobFinding(VM_ONE), blobFinding(VM_TWO)]);
    await storeOldScan('old-2', 2, [blobFinding(VM_ONE)]);
    await storeOldScan('old-3', 3, [null]);
    const blobsBefore = await blobsOf();

    await expect(backfillFindings()).resolves.toBeUndefined();

    // The two scans replayed before the failure left nothing behind.
    expect(await storedFindings()).toEqual([]);
    expect(await events()).toEqual([]);
    expect(await metaKeys()).toEqual([]);
    expect(await blobsOf()).toEqual(blobsBefore);

    await repairScan('old-3', [blobFinding(VM_ONE), blobFinding(VM_THREE)]);
    await backfillFindings();

    expect(await history()).toEqual([
      { name: 'vm-one', status: 'active', firstSeenAt: at(1), lastSeenAt: at(3), resolvedAt: null, timesSeen: 4 },
      { name: 'vm-three', status: 'active', firstSeenAt: at(3), lastSeenAt: at(3), resolvedAt: null, timesSeen: 2 },
      { name: 'vm-two', status: 'fixed', firstSeenAt: at(1), lastSeenAt: at(1), resolvedAt: at(2), timesSeen: 1 },
    ]);
    // The newest scan's transition is the only one with an event trail, and it is written once.
    expect(await events()).toEqual([{ type: 'created', category: 'identity', occurredAt: at(3) }]);
    expect(await metaKeys()).toEqual([FINDINGS_BACKFILL_MARKER, findingsBackfillCategoryKey('identity')]);
  });

  it('leaves a category it rebuilt alone on a retry, and rebuilds the one that failed', async () => {
    await storeOldScan('old-1', 1, [blobFinding(VM_ONE), blobFinding(VM_TWO)]);
    await storeOldScan('old-2', 2, [blobFinding(VM_ONE)]);
    await execRun(db.insert(scansTable).values({
      id: 'sec-1', module: 'security', startedAt: at(1), finishedAt: at(1),
      durationMs: 10, subscriptionsScanned: '[]', findings: '{not json', counts: '{}', totalRules: 1,
    }));

    await backfillFindings();
    const afterFirst = await storedFindings();
    const eventsAfterFirst = await events();
    expect(afterFirst).toHaveLength(2);
    expect(await metaKeys()).toEqual([findingsBackfillCategoryKey('identity')]);

    await backfillFindings();

    // identity is not replayed: its times seen and its events are what the first run left.
    expect(await storedFindings()).toEqual(afterFirst);
    expect(await events()).toEqual(eventsAfterFirst);
    expect(await metaKeys()).toEqual([findingsBackfillCategoryKey('identity')]);

    await execRun(db.update(scansTable).set({ findings: JSON.stringify([blobFinding(VM_THREE, { ruleId: SEC_RULE, category: 'security' })]) }).where(eq(scansTable.id, 'sec-1')));
    await backfillFindings();

    expect(await metaKeys()).toEqual([FINDINGS_BACKFILL_MARKER, findingsBackfillCategoryKey('identity'), findingsBackfillCategoryKey('security')]);
    expect((await storedFindings()).filter(f => f.category === 'identity')).toEqual(afterFirst);
    expect((await storedFindings()).filter(f => f.category === 'security').map(f => [f.resourceName, f.status, f.timesSeen])).toEqual([['vm-three', 'active', 2]]);
  });

  it('does not replay a category that was scanned since the failed start, and keeps its stored findings', async () => {
    await storeOldScan('old-1', 1, [blobFinding(VM_ONE), blobFinding(VM_TWO)]);
    await storeOldScan('old-2', 2, '{not json');
    await backfillFindings();
    expect(await storedFindings()).toEqual([]);
    expect(await metaKeys()).toEqual([]);

    // The app runs between the two starts: the category is scanned, and finds one VM.
    await scan([ARG_RULE], { rows: [VM_TWO] }, 0, new Date(at(5)));
    const scanned = await storedFindings();
    const scannedEvents = await events();
    expect(scanned.map(f => [f.resourceName, f.status])).toEqual([['vm-two', 'active']]);

    await repairScan('old-2', [blobFinding(VM_ONE)]);
    await backfillFindings();

    // Exactly as that scan left it: vm-one is not created, vm-two is not marked Fixed or moved back.
    expect(await storedFindings()).toEqual(scanned);
    expect(await events()).toEqual(scannedEvents);
    expect(await metaKeys()).toEqual([]);
    const stored = await blobsOf();
    expect(stored.filter(b => b.id.startsWith('old-')).map(b => b.findings)).toEqual([
      JSON.stringify([blobFinding(VM_ONE), blobFinding(VM_TWO)]), JSON.stringify([blobFinding(VM_ONE)]),
    ]);
  });

  it('sets the marker when nothing is stored, and when the only category with history is rebuilt', async () => {
    await backfillFindings();
    expect(await metaKeys()).toEqual([FINDINGS_BACKFILL_MARKER]);

    await clearBackfillMarkers();
    await storeOldScan('old-1', 1, [blobFinding(VM_ONE)]);

    await backfillFindings();

    expect(await metaKeys()).toEqual([FINDINGS_BACKFILL_MARKER, findingsBackfillCategoryKey('identity')]);
    expect((await history()).map(f => [f.name, f.status])).toEqual([['vm-one', 'active']]);
  });
});
