/**
 * Issue #216 (ADR 0008): a scan save stores one slim record per finding in `scan_findings`, in the same
 * transaction as the scan row, and keeps writing the findings blob. Driven through the highest seam:
 * runCategoryScan() over the fake Azure context, then reading the table back. Pruning, a deleted rule
 * and a rule id change are covered here too, since each is a rule about what happens to the records.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { computeActivityFingerprint, computeFingerprint } from '@rulebeat/core';
import { dbKind } from '@/lib/db/backend';
import { db } from '@/lib/db/client';
import { many, run as execRun } from '@/lib/db/exec';
import { rules as rulesTable, scanFindings, scans as scansTable } from '@/lib/db/tables';
import { getCategory } from '@/lib/db/categories';
import { deleteRule } from '@/lib/rules';
import { runCategoryScan } from '@/lib/scan-runner';
import { getScanById, saveScanResult } from '@/lib/scan-history';
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

async function scan(ruleIds: string[], ctxOptions: Parameters<typeof fakeTenantContext>[0], hoursFromBase = 0) {
  const category = (await getCategory('identity'))!;
  const outcome = await runCategoryScan(category, {
    ctx: fakeTenantContext(ctxOptions),
    ruleIds,
    now: new Date(Date.UTC(2026, 5, 1, hoursFromBase)),
  });
  const id = outcome.summary.id;
  if (!id) throw new Error('the scan was saved without an id');
  return { ...outcome, summary: { ...outcome.summary, id } };
}

const recordsOf = (scanId: string) => many(db
  .select().from(scanFindings).where(eq(scanFindings.scanId, scanId)).orderBy(asc(scanFindings.fingerprint)));

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

  it('is born converted, and still writes the findings blob exactly as before', async () => {
    const { summary } = await scan([ARG_RULE], { rows: [{ ...VM_ONE, n: 1 }] });
    const [row] = await many(db.select().from(scansTable).where(eq(scansTable.id, summary.id)));
    expect(row!.hasRecords).toBe(1);
    expect(JSON.parse(row!.findings)).toEqual(JSON.parse(JSON.stringify(summary.findings)));
    expect((await getScanById(summary.id))!.findings).toHaveLength(1);
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
