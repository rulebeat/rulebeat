/**
 * Issue #199 (ADR 0007): a scan writes each finding's rows to `finding_rows`, one record a row in
 * query order, and records how many there are and which scan stored them. A rule that did not
 * complete keeps the rows it had. Removing a rule's findings removes their rows. Driven through
 * runCategoryScan() over the fake Azure context; the table is read raw because which records exist
 * is the contract here, while the reads the app makes go through listFindings().
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { computeFingerprint } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { many, run as execRun } from '@/lib/db/exec';
import { findings as findingsTable, findingRows as findingRowsTable, rules as rulesTable } from '@/lib/db/tables';
import { getCategory } from '@/lib/db/categories';
import { deleteFindingsForRule, listFindings } from '@/lib/db/findings';
import { runCategoryScan } from '@/lib/scan-runner';
import { resetDb } from '../helpers/db';
import { fakeTenantContext, argRow } from '../helpers/fake-azure';

const RULE = 'test-rows-table-rule';
const KQL = 'resources | where type == "microsoft.compute/virtualmachines"';
const VM_ONE = argRow({ name: 'vm-one' });
const VM_TWO = argRow({ name: 'vm-two' });
const FP_ONE = computeFingerprint(RULE, String(VM_ONE.id));
const FP_TWO = computeFingerprint(RULE, String(VM_TWO.id));

async function insertRule(kql = KQL): Promise<void> {
  await execRun(db.delete(rulesTable).where(eq(rulesTable.id, RULE)));
  await execRun(db.insert(rulesTable).values({
    id: RULE, name: RULE, description: 'test rule', category: 'identity', severity: 'medium', enabled: true,
    scope: JSON.stringify({ level: 'subscription' }), resourceTypes: '[]', conditions: '[]', type: 'custom', rawKql: kql,
  }));
}

async function scan(ctxOptions: Parameters<typeof fakeTenantContext>[0], hoursFromBase = 0) {
  return runCategoryScan((await getCategory('identity'))!, {
    ctx: fakeTenantContext(ctxOptions),
    ruleIds: [RULE],
    now: new Date(Date.UTC(2026, 5, 1, hoursFromBase)),
  });
}

/** The stored records of a finding, in position order. */
async function recordsOf(fingerprint: string) {
  const records = await many(db.select().from(findingRowsTable).where(eq(findingRowsTable.fingerprint, fingerprint)));
  return records.sort((a, b) => a.position - b.position).map(r => ({ position: r.position, row: JSON.parse(r.data) as Record<string, unknown> }));
}

async function rowColumns(fingerprint: string) {
  const [row] = await many(db.select({ rowCount: findingsTable.rowCount, rowsScanId: findingsTable.rowsScanId, lastScanId: findingsTable.lastScanId })
    .from(findingsTable).where(eq(findingsTable.fingerprint, fingerprint)));
  return row;
}

beforeEach(async () => {
  await resetDb();
  await insertRule();
});

describe('a scan writes finding_rows', () => {
  it('stores one record a row, in query order, with the count and the scan that stored them', async () => {
    const outcome = await scan({ rows: [{ ...VM_ONE, n: 1 }, { ...VM_TWO, n: 9 }, { ...VM_ONE, n: 2 }, { ...VM_ONE, n: 3 }] });

    expect((await recordsOf(FP_ONE)).map(r => [r.position, r.row.n])).toEqual([[0, 1], [1, 2], [2, 3]]);
    expect((await recordsOf(FP_TWO)).map(r => [r.position, r.row.n])).toEqual([[0, 9]]);
    expect(await rowColumns(FP_ONE)).toEqual({ rowCount: 3, rowsScanId: outcome.summary.id, lastScanId: outcome.summary.id });
  });

  it('replaces the records when the next scan returns different rows', async () => {
    await scan({ rows: [{ ...VM_ONE, n: 1 }, { ...VM_ONE, n: 2 }, { ...VM_ONE, n: 3 }] });
    const second = await scan({ rows: [{ ...VM_ONE, n: 4 }] }, 24);

    expect((await recordsOf(FP_ONE)).map(r => [r.position, r.row.n])).toEqual([[0, 4]]);
    expect(await rowColumns(FP_ONE)).toEqual({ rowCount: 1, rowsScanId: second.summary.id, lastScanId: second.summary.id });
    expect((await listFindings()).find(f => f.fingerprint === FP_ONE)!.rows.map(r => r.n)).toEqual([4]);
  });

  it('keeps the records, and marks them current, when the rule was capped', async () => {
    await scan({ rows: [{ ...VM_ONE, n: 1 }, { ...VM_ONE, n: 2 }] });
    await insertRule(`${KQL} | take 1`);
    const capped = await scan({ rows: [{ ...VM_ONE, n: 7 }] }, 24);
    expect(capped.summary.incompleteRules.map(r => r.status)).toEqual(['capped']);

    expect((await recordsOf(FP_ONE)).map(r => r.row.n)).toEqual([1, 2]);
    expect(await rowColumns(FP_ONE)).toEqual({ rowCount: 2, rowsScanId: capped.summary.id, lastScanId: capped.summary.id });
  });

  it('leaves rows a start could not copy marked for the next start, when the rule was capped', async () => {
    await scan({ rows: [{ ...VM_ONE, n: 1 }] });
    // What a database holds after the previous release rescanned it and the copy on this start failed.
    await execRun(db.update(findingsTable).set({ rowsScanId: 'scan-before', lastScanId: 'scan-older-release' }).where(eq(findingsTable.fingerprint, FP_ONE)));
    await insertRule(`${KQL} | take 1`);
    const capped = await scan({ rows: [{ ...VM_ONE, n: 7 }] }, 24);

    expect(await rowColumns(FP_ONE)).toEqual({ rowCount: 1, rowsScanId: 'scan-before', lastScanId: capped.summary.id });
  });
});

describe('removing a rule\'s findings', () => {
  it('removes their rows and nothing else', async () => {
    await scan({ rows: [{ ...VM_ONE, n: 1 }, { ...VM_TWO, n: 2 }] });
    await execRun(db.insert(findingRowsTable).values({ fingerprint: 'another-rules-finding', position: 0, data: '{}' }));

    expect(await deleteFindingsForRule(RULE)).toBe(2);

    const left = await many(db.select({ fingerprint: findingRowsTable.fingerprint }).from(findingRowsTable).where(sql`1 = 1`));
    expect(left).toEqual([{ fingerprint: 'another-rules-finding' }]);
  });
});
