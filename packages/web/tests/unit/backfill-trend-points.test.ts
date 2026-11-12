/**
 * #324: the one-time trend backfill approximates past days from stored scan blobs. Those points are
 * guesses (no unknown-rule split, no last-run check), yet they are written dated in the past and
 * under the current formula version, so the baseline comparison trusts them as honest history.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { scans as scansTable } from '@/lib/db/tables';
import { deleteMeta } from '@/lib/db/meta';
import { backfillSnapshots, getSnapshots } from '@/lib/db/snapshots';
import { SNAPSHOTS_BACKFILL_MARKER } from '@/lib/db/scan-findings-copy';
import { computeWidgetSummary } from '@/lib/dashboard-data';
import { resetDb } from '../helpers/db';
import { EVERYTHING_ACCESS } from '../helpers/access';

const CATEGORY = 'security';
const DAY_MS = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);

/** A scan the way the previous release stored it: a finished scan whose blob holds its findings. */
async function storeBlobScan(id: string, daysAgo: number, totalRules: number): Promise<void> {
  const at = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
  await execRun(db.insert(scansTable).values({
    id,
    module: CATEGORY,
    startedAt: at,
    finishedAt: at,
    durationMs: 10,
    subscriptionsScanned: '[]',
    findings: '[]',
    counts: '{}',
    totalRules,
  }));
}

describe('backfillSnapshots over stored scan-blob history (#324)', () => {
  beforeEach(async () => {
    await resetDb();
    await deleteMeta(SNAPSHOTS_BACKFILL_MARKER);
    await storeBlobScan('blob-scan-30', 30, 4);
    await storeBlobScan('blob-scan-10', 10, 4);
  });

  it('writes no trend point dated before today', async () => {
    await backfillSnapshots();

    const points = await getSnapshots(EVERYTHING_ACCESS, { categories: [CATEGORY] });
    expect(points.filter(p => p.date < today()).map(p => p.date)).toEqual([]);
  });

  it('leaves computeWidgetSummary with no baseline that came from a blob-derived point', async () => {
    await backfillSnapshots();

    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: { mode: 'relative', days: 7 } }, EVERYTHING_ACCESS);

    // Nothing but blob-derived points sit on or before the window start, so there is nothing honest to compare against.
    expect(summary.baseline).toBeNull();
  });
});
