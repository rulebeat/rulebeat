/**
 * Last scanned follows what you hold: the newest finished scan of a category whose covered Scope overlaps
 * the viewer's Scopes (a null covered Scope, from before #276, reads as Everything), searched back past the
 * scans that do not. Everything reads the newest scan of the category, whatever it covered.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { scans as scansTable } from '@/lib/db/tables';
import { buildAccess, everythingAccess, NO_ACCESS, parseScope, type Access } from '@/lib/access-model';
import { listLastScanTimes, saveScanResult } from '@/lib/scan-history';
import type { CoveredEntry } from '@/lib/run-scope';
import { emptySeverityCounts } from '@/lib/severity';
import { resetDb } from '../helpers/db';

const SUB_ONE = '00000000-0000-0000-0000-00000000000a';
const SUB_TWO = '00000000-0000-0000-0000-00000000000b';
const covering = (sub: string): CoveredEntry[] => [{ tenantId: 'tenant-1', path: `/subscriptions/${sub}` }];
const holding = (sub: string): Access =>
  buildAccess([{ tenantId: 'tenant-1', scope: parseScope(`/subscriptions/${sub}`)!, role: 'viewer' }], 'manual');

const TEN_DAYS_AGO = '2026-10-29T08:00:00.000Z';
const YESTERDAY = '2026-11-08T08:00:00.000Z';

async function save(id: string, module: string, finishedAt: string, coveredScope?: CoveredEntry[]): Promise<void> {
  await saveScanResult(module, {
    id, module, startedAt: finishedAt, finishedAt, durationMs: 1, subscriptionsScanned: [], findings: [],
    counts: emptySeverityCounts(), totalRules: 1, coverage: 'complete', incompleteRules: [],
  }, { id, coveredScope });
}

describe('listLastScanTimes', () => {
  beforeEach(async () => {
    await resetDb();
    await save('old-one', 'security', TEN_DAYS_AGO, covering(SUB_ONE));
    await save('new-two', 'security', YESTERDAY, covering(SUB_TWO));
  });

  it('gives Everything the newest scan of the category, whatever it covered', async () => {
    expect((await listLastScanTimes(['security'], everythingAccess('admin'))).get('security')).toBe(YESTERDAY);
  });

  it('gives a person who holds one subscription the newest scan that covered it, past a newer scan of another', async () => {
    expect((await listLastScanTimes(['security'], holding(SUB_ONE))).get('security')).toBe(TEN_DAYS_AGO);
    expect((await listLastScanTimes(['security'], holding(SUB_TWO))).get('security')).toBe(YESTERDAY);
  });

  it('counts a scan stored with no covered Scope, from before #276, for a scoped person', async () => {
    await save('legacy', 'security', '2026-11-01T08:00:00.000Z', covering(SUB_TWO));
    await execRun(db.update(scansTable).set({ coveredScope: null }).where(eq(scansTable.id, 'legacy')));
    expect((await listLastScanTimes(['security'], holding(SUB_ONE))).get('security')).toBe('2026-11-01T08:00:00.000Z');
  });

  it('leaves out a category with no scan that overlaps, and a person who holds nothing', async () => {
    expect((await listLastScanTimes(['security'], holding('00000000-0000-0000-0000-00000000000c'))).has('security')).toBe(false);
    expect((await listLastScanTimes(['security'], NO_ACCESS)).size).toBe(0);
  });

  it('reads each category on its own', async () => {
    await save('cost-two', 'cost', YESTERDAY, covering(SUB_TWO));
    const times = await listLastScanTimes(['security', 'cost', 'identity'], holding(SUB_ONE));
    expect([...times.entries()]).toEqual([['security', TEN_DAYS_AGO]]);
  });
});
