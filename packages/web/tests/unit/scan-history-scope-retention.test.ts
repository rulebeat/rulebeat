/**
 * Issue #401: pruning keeps a category's newest scans up to the history limit, and beyond that limit
 * never deletes the newest finished scan for each distinct Scope the scans covered, with its records.
 * Driven through saveScanResult(), which prunes the category after each save. The limit is lowered
 * through its env setting, which is read when scan-history is first imported.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { many, run as execRun } from '@/lib/db/exec';
import { scanFindings, scans as scansTable } from '@/lib/db/tables';
import { saveScanResult, SCAN_HISTORY_LIMIT } from '@/lib/scan-history';
import { EVERYTHING_COVERED, type CoveredEntry } from '@/lib/run-scope';
import type { ScanSummary } from '@/lib/types';
import { countRows, resetDb } from '../helpers/db';
import { fakeTenantContext, argRow } from '../helpers/fake-azure';
import { runCategoryScan } from '@/lib/scan-runner';
import { getCategory } from '@/lib/db/categories';
import { EVERYTHING_ACCESS } from '../helpers/access';
import { rules as rulesTable } from '@/lib/db/tables';

const previousLimit = vi.hoisted(() => {
  const before = process.env.SCAN_HISTORY_LIMIT;
  process.env.SCAN_HISTORY_LIMIT = '2';
  return before;
});
afterAll(() => {
  if (previousLimit === undefined) delete process.env.SCAN_HISTORY_LIMIT;
  else process.env.SCAN_HISTORY_LIMIT = previousLimit;
});

const RULE = 'test-scope-retention-rule';
const TENANT = '00000000-0000-0000-0000-0000000000aa';
const SUB_A: CoveredEntry[] = [{ tenantId: TENANT, path: '/subscriptions/aaaaaaaa-0000-0000-0000-000000000001' }];
const SUB_B: CoveredEntry[] = [{ tenantId: TENANT, path: '/subscriptions/bbbbbbbb-0000-0000-0000-000000000002' }];
const MODULE = 'compute';

let template: ScanSummary;

beforeEach(async () => {
  await resetDb();
  await execRun(db.delete(rulesTable).where(eq(rulesTable.id, RULE)));
  await execRun(db.insert(rulesTable).values({
    id: RULE, name: RULE, description: 'd', category: 'identity', severity: 'medium', enabled: true,
    scope: JSON.stringify({ level: 'subscription' }), resourceTypes: '[]', conditions: '[]', type: 'custom',
    rawKql: 'resources | where type == "microsoft.compute/virtualmachines"',
  }));
  const category = (await getCategory('identity'))!;
  const outcome = await runCategoryScan(category, {
    access: EVERYTHING_ACCESS,
    ctx: fakeTenantContext({ rows: [argRow({ name: 'vm-one' })] }),
    ruleIds: [RULE],
    now: new Date(Date.UTC(2026, 5, 1)),
  });
  template = outcome.summary;
  expect(template.findings).toHaveLength(1);
  await resetDb();
});

/** Saves a scan of the test category started `hour` hours after a fixed day, with one finding. */
const save = (id: string, hour: number, coveredScope?: readonly CoveredEntry[]) => saveScanResult(MODULE, {
  ...template,
  id,
  module: MODULE,
  startedAt: new Date(Date.UTC(2026, 6, 1, hour)).toISOString(),
  finishedAt: new Date(Date.UTC(2026, 6, 1, hour, 1)).toISOString(),
}, { id, coveredScope });

const storedIds = async () => (await many(db.select({ id: scansTable.id }).from(scansTable))).map(s => s.id).sort();
const recordsOf = (scanId: string) => many(db.select().from(scanFindings).where(eq(scanFindings.scanId, scanId)));

describe('pruning with scans that covered different Scopes', () => {
  it('runs with the limit lowered by its env setting', () => {
    expect(SCAN_HISTORY_LIMIT).toBe(2);
  });

  it('keeps the newest scan of a Scope that has fallen out of the limit, with its records', async () => {
    await save('b-old', 0, SUB_B);
    for (let hour = 1; hour <= 5; hour++) await save(`a-${hour}`, hour, SUB_A);

    expect(await storedIds()).toEqual(['a-4', 'a-5', 'b-old']);
    expect(await recordsOf('b-old')).toHaveLength(1);
    expect(await recordsOf('a-5')).toHaveLength(1);
    for (const id of ['a-1', 'a-2', 'a-3']) expect(await recordsOf(id)).toEqual([]);
    expect(await countRows('scan_findings')).toBe(3);
  });

  it('keeps only the newest of a Scope, not every scan of it', async () => {
    await save('b-1', 0, SUB_B);
    await save('b-2', 1, SUB_B);
    for (let hour = 2; hour <= 5; hour++) await save(`a-${hour}`, hour, SUB_A);

    expect(await storedIds()).toEqual(['a-4', 'a-5', 'b-2']);
    expect(await recordsOf('b-1')).toEqual([]);
  });

  it('reads the same Scopes in a different order or casing as one Scope', async () => {
    const both = [...SUB_A, ...SUB_B];
    const reversed = [{ ...SUB_B[0], path: SUB_B[0].path.toUpperCase() }, SUB_A[0]];
    await save('both-1', 0, both);
    await save('both-2', 1, reversed);
    for (let hour = 2; hour <= 5; hour++) await save(`e-${hour}`, hour);

    expect(await storedIds()).toEqual(['both-2', 'e-4', 'e-5']);
  });

  it('treats a scan with no covered Scope as Everything', async () => {
    await save('null-old', 0);
    await execRun(db.update(scansTable).set({ coveredScope: null }).where(eq(scansTable.id, 'null-old')));
    for (let hour = 1; hour <= 4; hour++) await save(`a-${hour}`, hour, SUB_A);

    expect(await storedIds()).toEqual(['a-3', 'a-4', 'null-old']);
    expect(await recordsOf('null-old')).toHaveLength(1);
  });

  it('keeps one scan for Everything when a null Scope and a stored Everything scan both fall out of the limit', async () => {
    await save('null-old', 0);
    await execRun(db.update(scansTable).set({ coveredScope: null }).where(eq(scansTable.id, 'null-old')));
    await save('everything', 1, EVERYTHING_COVERED);
    for (let hour = 2; hour <= 5; hour++) await save(`a-${hour}`, hour, SUB_A);

    expect(await storedIds()).toEqual(['a-4', 'a-5', 'everything']);
    expect(await recordsOf('null-old')).toEqual([]);
  });

  it('protects scans of the category only, and prunes another category on its own', async () => {
    await saveScanResult('network', { ...template, id: 'n-old', module: 'network', startedAt: new Date(Date.UTC(2026, 6, 1, 0)).toISOString() }, { id: 'n-old', coveredScope: SUB_B });
    await save('c-1', 1, SUB_A);
    await save('c-2', 2, SUB_A);
    await save('c-3', 3, SUB_A);

    expect(await storedIds()).toEqual(['c-2', 'c-3', 'n-old']);
  });
});
