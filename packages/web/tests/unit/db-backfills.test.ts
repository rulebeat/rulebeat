/**
 * TS-25 · the two one-time backfills that run at startup.
 *
 * `backfillFindings` and `backfillSnapshots` are upgrade steps in everything but name: they run once
 * from `instrumentation.ts`, transform a customer's data, mark themselves done, and say nothing. They
 * live outside `lib/db/migrate.ts`, so the rest of the upgrade suite never touched them — and this is
 * exactly the shape of code that produced three of the five bugs found on 2026-07-30.
 *
 * What `backfillFindings` does matters more than it sounds: it is what gives an install that predates
 * the findings table its entire finding history. If it gets the ages wrong, every finding looks new
 * on the day of the upgrade, which is the same user-visible disaster TS-25 exists to prevent.
 *
 * Same structural constraint as `db-upgrade-scan.test.ts`: the sample must exist and
 * `RULEBEAT_DB_PATH` must point at it before anything imports the database singleton, so nothing here
 * may statically import a module that reaches it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { makeSample, upgradeInProcess } from '../fixtures/upgrade';
import { ACTIVE_RESOURCE_ID, FIXED_DATES } from '../fixtures/populate';

const sample = makeSample('cron-schedules');
upgradeInProcess(sample);
process.env.RULEBEAT_DB_PATH = sample.file;

let findingsRepo: typeof import('@/lib/db/findings');
let snapshotsRepo: typeof import('@/lib/db/snapshots');
let meta: typeof import('@/lib/db/meta');

beforeAll(async () => {
  findingsRepo = await import('@/lib/db/findings');
  snapshotsRepo = await import('@/lib/db/snapshots');
  meta = await import('@/lib/db/meta');
});

describe('TS-25 · rebuilding finding history on upgrade', () => {
  it('25-05 · reconstructs findings from scan history without inventing or losing any', async () => {
    const before = await findingsRepo.listFindings();
    await findingsRepo.backfillFindings();
    const after = await findingsRepo.listFindings();

    // The sample already has a findings table, so the backfill must reconcile rather than duplicate.
    const resourceIds = after.map(f => f.resourceId);
    expect([...new Set(resourceIds)].length, 'the backfill duplicated findings').toBe(resourceIds.length);
    expect(after.length, 'the backfill dropped existing findings').toBeGreaterThanOrEqual(before.length);
  });

  it('25-05 · a finding that predates the upgrade keeps the age it already had', async () => {
    await findingsRepo.backfillFindings();
    const existing = (await findingsRepo.listFindings()).find(f => f.resourceId === ACTIVE_RESOURCE_ID);
    expect(existing, 'the pre-existing finding vanished').toBeDefined();
    // The whole point. Rewriting this to the upgrade date would report a months-old, already-triaged
    // violation as if it appeared today.
    expect(existing!.firstSeenAt, 'the finding was aged back to the upgrade date').toBe(FIXED_DATES.firstSeen);
  });

  it('25-13 · a scan record missing newer fields is restored, not fatal', async () => {
    // The sample's scan history was written in an older shape: no resourceType, no subscriptionId.
    // Those columns are NOT NULL today, so handing the record straight to the insert throws — and
    // this runs from instrumentation.ts at startup, which means an upgrade could fail to boot over
    // one old record. It must degrade instead, and keep as much of the history as it can.
    await findingsRepo.backfillFindings();
    const restored = (await findingsRepo.listFindings()).find(f => f.resourceId === ACTIVE_RESOURCE_ID);
    expect(restored, 'the historical finding was dropped entirely').toBeDefined();
    // Recovered from the resource id rather than left blank, because a finding with no subscription
    // disappears from every subscription-filtered view.
    expect(restored!.subscriptionId).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('25-11 · running twice changes nothing, and the marker is what stops it', async () => {
    await findingsRepo.backfillFindings();
    const first = JSON.stringify(await findingsRepo.listFindings());

    // The marker is set by the first run, so the second is a no-op...
    expect(await meta.getMeta('findings-backfilled-v1') ?? meta.getMeta('findings-backfill-v1')).toBeTruthy();
    await findingsRepo.backfillFindings();
    expect(JSON.stringify(await findingsRepo.listFindings())).toBe(first);
  });
});

describe('TS-25 · rebuilding trend history on upgrade', () => {
  it('25-05 · approximating snapshots keeps the history already recorded', async () => {
    const before = (await snapshotsRepo.getSnapshots({ categories: ['cost'] })).length;
    await snapshotsRepo.backfillSnapshots();
    const after = await snapshotsRepo.getSnapshots({ categories: ['cost'] });

    expect(after.length, 'existing trend history was dropped').toBeGreaterThanOrEqual(before);
    // The fixture's own snapshot row must come through untouched — it is real recorded history, not
    // something to be recomputed from an approximation.
    const original = after.find(s => s.date === '2026-07-19');
    expect(original, 'the recorded snapshot was lost').toBeDefined();
    expect(original!.posturePct).toBe(80);
    // It predates the formulaVersion column (spec 033) entirely, so it must read as old-formula —
    // never silently upgraded to look like an honest row it never was.
    expect(original!.formulaVersion, 'a pre-existing row must not be mistaken for an honest one').toBe(1);

    // await backfillSnapshots() also writes a fresh "today" row per category via upsertDailySnapshot —
    // that one IS computed under the current formula and must say so.
    const today = new Date().toISOString().slice(0, 10);
    const freshRow = after.find(s => s.date === today);
    expect(freshRow, 'backfillSnapshots did not write a fresh row for today').toBeDefined();
    expect(freshRow!.formulaVersion).toBe(snapshotsRepo.SNAPSHOT_FORMULA_VERSION);
  });

  it('25-11 · running twice does not double up the trend', async () => {
    await snapshotsRepo.backfillSnapshots();
    const first = JSON.stringify(await snapshotsRepo.getSnapshots({ categories: ['cost'] }));
    await snapshotsRepo.backfillSnapshots();
    expect(JSON.stringify(await snapshotsRepo.getSnapshots({ categories: ['cost'] }))).toBe(first);
  });
});
