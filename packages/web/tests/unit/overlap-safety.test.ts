/**
 * Issue #88: two RuleBeat processes sharing one database for the length of a rolling deploy must
 * not run a due schedule twice, send a notification batch twice, or mark each other's live scan
 * as crashed. Every coordination write is one conditional UPDATE, so these tests drive two
 * "instances" from one process by calling the same entry point twice at once against the same
 * rows. That is exactly the race two containers have, minus the network, and it runs unchanged on
 * SQLite and on the Postgres CI job.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenCredential } from '@azure/identity';
import type { TenantContext } from '@rulebeat/core';
import { computeFingerprint } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { rules as rulesTable } from '@/lib/db/tables';
import {
  createSchedule, getSchedule, listDueSchedules, claimDueSchedule, advanceScheduleAfterRun,
} from '@/lib/db/schedules';
import { runDueSchedules } from '@/lib/scheduler';
import { executeTarget } from '@/lib/run-executor';
import {
  startRun, finishRun, getRun, listAllRuns, claimNotifyDispatch, STALE_AFTER_MS,
} from '@/lib/schedule-runs';
import { recoverInterruptedRuns, recoverPendingNotifications } from '@/lib/startup-recovery';
import { dispatchAndMarkSent } from '@/lib/notifications/dispatch';
import { createChannel, deleteChannel } from '@/lib/db/notification-channels';
import { setLinksForSchedule, deleteLinksForSchedule } from '@/lib/db/schedule-notification-channels';
import { setDnsLookupForTests, resetDnsLookupForTests } from '@/lib/ssrf-guard';
import { syncScanFindings } from '@/lib/db/findings';
import { INSTANCE_ID } from '@/lib/instance-id';
import { resetDb, clearRules, countRows, execRaw } from '../helpers/db';
import { argRow, TEST_SUB_A } from '../helpers/fake-azure';
import type { Finding } from '@/lib/types';

const RULE_A = 'overlap-rule-a';
const CATEGORY = 'security';
const MINUTE_MS = 60_000;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** A tenant that answers every Resource Graph query with one VM row after `delayMs`, so a scan
 *  stays in flight long enough to be observed mid-run. */
function slowCtx(delayMs: number): TenantContext {
  return {
    tenantId: 'test-tenant',
    subscriptionIds: [TEST_SUB_A],
    credential: {} as TokenCredential,
    log: () => {},
    async graphGet<TValue = Record<string, unknown>>(): Promise<TValue[]> { return []; },
    async queryLogs<TRow = Record<string, unknown>>(): Promise<TRow[]> { return []; },
    async queryARG<TRow = Record<string, unknown>>(): Promise<TRow[]> {
      await sleep(delayMs);
      return [argRow({ name: 'vm-1' })] as TRow[];
    },
  };
}

async function insertRule(id: string): Promise<void> {
  await execRun(db.insert(rulesTable).values({
    id,
    name: id,
    description: 'test rule',
    category: CATEGORY,
    severity: 'medium',
    enabled: true,
    scope: JSON.stringify({ level: 'subscription' }),
    resourceTypes: JSON.stringify([]),
    conditions: JSON.stringify([]),
    rawKql: 'resources | where type == "microsoft.compute/virtualmachines"',
    type: 'custom',
  }));
}

/** A daily schedule whose next occurrence is already in the past, i.e. due on the next tick. */
async function dueSchedule(name = 'Nightly') {
  const startAt = new Date(Date.now() - 2 * 24 * 60 * MINUTE_MS);
  startAt.setSeconds(0, 0);
  const result = await createSchedule({
    name, targetType: 'all', targetValues: [], recurrenceType: 'daily', interval: 1,
    daysOfWeek: null, dayOfMonth: null, startAt: startAt.toISOString(), endType: 'never', endDate: null,
  });
  if ('error' in result) throw new Error(result.error);
  // createSchedule computes next_run_at from now, which is in the future by construction; move it
  // into the past the way real time passing does, so listDueSchedules() picks it up.
  await execRaw(`UPDATE schedules SET next_run_at = '${iso(-MINUTE_MS)}' WHERE id = '${result.schedule.id}'`);
  return (await getSchedule(result.schedule.id))!;
}

function finding(resourceSuffix: string): Finding {
  const resourceId = `/subscriptions/sub-1/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/${resourceSuffix}`;
  return {
    module: CATEGORY, ruleId: RULE_A, fingerprint: computeFingerprint(RULE_A, resourceId), severity: 'medium',
    category: CATEGORY, resourceId, resourceType: 'microsoft.compute/virtualmachines', resourceName: resourceSuffix,
    subscriptionId: 'sub-1', title: 'test finding', description: 'test', evidence: {}, recommendation: 'fix it',
    remediationSteps: [], detectedAt: new Date().toISOString(),
  };
}

function fakeResponse(status: number): Response {
  return { ok: status >= 200 && status < 300, status, type: 'basic', text: async () => '' } as Response;
}

beforeEach(async () => {
  await resetDb();
  await clearRules();
});

describe('a due schedule is claimed before it runs', () => {
  it('two schedulers ticking at once over the same due schedule produce exactly one run', async () => {
    const schedule = await dueSchedule();
    const ctx = slowCtx(0);

    await Promise.all([runDueSchedules({ ctx }), runDueSchedules({ ctx })]);

    expect(await countRows('schedule_runs')).toBe(1);
    const after = (await getSchedule(schedule.id))!;
    expect(after.nextRunAt).not.toBeNull();
    expect(after.nextRunAt! > new Date().toISOString()).toBe(true);
    expect(after.lastRunAt).not.toBeNull();
  });

  it('of two claims made from the same seen value, exactly one succeeds', async () => {
    const schedule = await dueSchedule();
    const next = iso(24 * 60 * MINUTE_MS);

    const results = await Promise.all([
      claimDueSchedule(schedule, next, iso(0)),
      claimDueSchedule(schedule, next, iso(0)),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await getSchedule(schedule.id))!.nextRunAt).toBe(next);
  });

  it('a claim made from a value the row no longer holds fails and changes nothing', async () => {
    const schedule = await dueSchedule();
    const seenByALaterTick = { ...schedule, nextRunAt: iso(-5 * MINUTE_MS) };

    expect(await claimDueSchedule(seenByALaterTick, iso(60 * MINUTE_MS), iso(0))).toBe(false);
    expect((await getSchedule(schedule.id))!.nextRunAt).toBe(schedule.nextRunAt);
  });

  it('the schedule stops being due the moment the scan starts, not when it ends', async () => {
    await insertRule(RULE_A);
    const schedule = await dueSchedule();
    expect((await listDueSchedules(iso(0))).map(s => s.id)).toEqual([schedule.id]);

    const inFlight = runDueSchedules({ ctx: slowCtx(80) });
    await sleep(30);
    // Mid-scan: a second process's tick lists nothing due, so it never even reaches the claim.
    expect(await listDueSchedules(iso(0))).toEqual([]);
    await inFlight;

    expect(await countRows('schedule_runs')).toBe(1);
  });

  it('a run records which process started it', async () => {
    await dueSchedule();
    await runDueSchedules({ ctx: slowCtx(0) });

    const [run] = await listAllRuns();
    expect(run!.ownerId).toBe(INSTANCE_ID);
    expect(run!.heartbeatAt).toBe(run!.startedAt);
  });

  it('the disabled-by-hand case: a schedule with no next occurrence can still be claimed for Run now', async () => {
    const schedule = await dueSchedule();
    await execRaw(`UPDATE schedules SET next_run_at = NULL, enabled = ${'false'} WHERE id = '${schedule.id}'`);
    const byHand = (await getSchedule(schedule.id))!;
    expect(byHand.nextRunAt).toBeNull();

    expect(await claimDueSchedule(byHand, iso(60 * MINUTE_MS), iso(0))).toBe(true);
    expect((await getSchedule(schedule.id))!.lastRunAt).not.toBeNull();
  });
});

describe('after the run, next_run_at moves on from the finish time', () => {
  it('advances from the claimed value to the first occurrence after the finish', async () => {
    const schedule = await dueSchedule();
    const claimed = iso(60 * MINUTE_MS);
    expect(await claimDueSchedule(schedule, claimed, iso(0))).toBe(true);

    const afterFinish = iso(120 * MINUTE_MS);
    expect(await advanceScheduleAfterRun(schedule.id, claimed, afterFinish)).toBe(true);
    expect((await getSchedule(schedule.id))!.nextRunAt).toBe(afterFinish);
  });

  it("an operator's edit made during the run wins over the re-advance", async () => {
    const schedule = await dueSchedule();
    const claimed = iso(60 * MINUTE_MS);
    expect(await claimDueSchedule(schedule, claimed, iso(0))).toBe(true);

    const edited = iso(7 * 24 * 60 * MINUTE_MS);
    await execRaw(`UPDATE schedules SET next_run_at = '${edited}' WHERE id = '${schedule.id}'`);

    expect(await advanceScheduleAfterRun(schedule.id, claimed, iso(120 * MINUTE_MS))).toBe(false);
    expect((await getSchedule(schedule.id))!.nextRunAt).toBe(edited);
  });

  it('is a no-op when the finish-time occurrence is the one the claim already wrote', async () => {
    const schedule = await dueSchedule();
    const claimed = iso(60 * MINUTE_MS);
    expect(await claimDueSchedule(schedule, claimed, iso(0))).toBe(true);

    expect(await advanceScheduleAfterRun(schedule.id, claimed, claimed)).toBe(false);
    expect((await getSchedule(schedule.id))!.nextRunAt).toBe(claimed);
  });
});

describe('a running row proves it is alive, and only a silent one is reaped', () => {
  it('the heartbeat advances while the scan is in flight', async () => {
    await insertRule(RULE_A);

    const run = await executeTarget(
      { targetType: 'categories', targetValues: [CATEGORY] },
      { triggeredBy: 'manual', ctx: slowCtx(80), heartbeatIntervalMs: 10 },
    );

    expect(run.status).toBe('success');
    expect(run.heartbeatAt).not.toBeNull();
    expect(run.heartbeatAt! > run.startedAt).toBe(true);
  });

  it('startup recovery leaves a run with a fresh heartbeat alone: it belongs to a live process', async () => {
    const run = await startRun({ scheduleId: '', triggeredBy: 'manual', categories: [CATEGORY] });

    expect(await recoverInterruptedRuns()).toBe(0);
    expect((await getRun(run.id))!.status).toBe('running');
  });

  it('startup recovery reaps a run whose heartbeat is older than the stale window', async () => {
    const run = await startRun({ scheduleId: '', triggeredBy: 'manual', categories: [CATEGORY] });
    await execRaw(`UPDATE schedule_runs SET heartbeat_at = '${iso(-STALE_AFTER_MS - MINUTE_MS)}' WHERE id = '${run.id}'`);

    expect(await recoverInterruptedRuns()).toBe(1);
    const after = (await getRun(run.id))!;
    expect(after.status).toBe('error');
    expect(after.error).toBe('Run did not complete. The server restarted or crashed while this scan was in progress.');
  });

  it('a row from before the heartbeat column existed (NULL) is stale, as every leftover running row was before', async () => {
    const run = await startRun({ scheduleId: '', triggeredBy: 'manual', categories: [CATEGORY] });
    await execRaw(`UPDATE schedule_runs SET heartbeat_at = NULL, owner_id = NULL WHERE id = '${run.id}'`);

    expect(await recoverInterruptedRuns()).toBe(1);
    expect((await getRun(run.id))!.status).toBe('error');
  });

  it('a stale heartbeat that is refreshed again is no longer stale', async () => {
    const run = await startRun({ scheduleId: '', triggeredBy: 'manual', categories: [CATEGORY] });
    await execRaw(`UPDATE schedule_runs SET heartbeat_at = '${iso(-STALE_AFTER_MS - MINUTE_MS)}' WHERE id = '${run.id}'`);
    // The live process beats once more before anyone sweeps.
    const { heartbeatRun } = await import('@/lib/schedule-runs');
    await heartbeatRun(run.id);

    expect(await recoverInterruptedRuns()).toBe(0);
  });
});

describe('a notification batch is sent once, whichever process gets to it', () => {
  let scheduleId: string;
  let channelId: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    scheduleId = `sched-${crypto.randomUUID()}`;
    channelId = (await createChannel({ name: 'Test channel', type: 'webhook', url: 'https://example.test/hook' })).id;
    await setLinksForSchedule(scheduleId, [{ channelId, minSeverity: 'low', categoryIds: null, subscriptionIds: null }]);
    setDnsLookupForTests(async () => [{ address: '93.184.216.34' }]);
    fetchMock = vi.fn().mockResolvedValue(fakeResponse(200));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    resetDnsLookupForTests();
    await deleteLinksForSchedule(scheduleId);
    await deleteChannel(channelId);
  });

  async function pendingRun() {
    const f = finding('vm-1');
    await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: new Date().toISOString() });
    const run = await startRun({ scheduleId, triggeredBy: 'schedule', categories: [CATEGORY] });
    await finishRun(run.id, {
      status: 'success', totalFindings: 1, newFindings: 1,
      newFindingFingerprints: [f.fingerprint], durationMs: 100, notifyStatus: 'pending',
    });
    return { run: (await getRun(run.id))!, findings: [f] };
  }

  it('two processes dispatching the same pending run at once deliver it once per channel', async () => {
    const { run, findings } = await pendingRun();

    const results = await Promise.all([
      dispatchAndMarkSent(run, findings),
      dispatchAndMarkSent(run, findings),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await getRun(run.id))!.notifyStatus).toBe('sent');
  });

  it('two startup recoveries over the same pending rows deliver each once', async () => {
    await pendingRun();

    const recovered = await Promise.all([recoverPendingNotifications(), recoverPendingNotifications()]);

    expect(recovered[0]! + recovered[1]!).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a fresh sending claim belongs to a live process and is left alone', async () => {
    const { run } = await pendingRun();
    expect(await claimNotifyDispatch(run.id)).toBe(true);

    expect(await recoverPendingNotifications()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await getRun(run.id))!.notifyStatus).toBe('sending');
  });

  it('a sending claim older than the stale window is taken over and delivered', async () => {
    const { run } = await pendingRun();
    expect(await claimNotifyDispatch(run.id)).toBe(true);
    await execRaw(`UPDATE schedule_runs SET notify_claimed_at = '${iso(-STALE_AFTER_MS - MINUTE_MS)}' WHERE id = '${run.id}'`);

    expect(await recoverPendingNotifications()).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await getRun(run.id))!.notifyStatus).toBe('sent');
  });

  it('a second claim on a row that was just claimed fails', async () => {
    const { run } = await pendingRun();
    expect(await claimNotifyDispatch(run.id)).toBe(true);
    expect(await claimNotifyDispatch(run.id)).toBe(false);
  });
});
