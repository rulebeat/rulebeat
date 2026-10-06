/**
 * Issue #144: a finding that is suppressed when a run's notifications go out is not part of them.
 * A suppressed finding whose resource is fixed and later breaks again reactivates under the same
 * fingerprint and counts as new in the scan, so the decision is made at dispatch time, in
 * dispatchAndMarkSent(), which both the live post-scan path and startup recovery call.
 *
 * What was sent is read off the guarded transport the SSRF tests already use, so no socket opens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenCredential } from '@azure/identity';
import type { TenantContext } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { rules as rulesTable } from '@/lib/db/tables';
import { listFindings } from '@/lib/db/findings';
import { startRun, finishRun, getRun } from '@/lib/schedule-runs';
import { recoverPendingNotifications } from '@/lib/startup-recovery';
import { executeTarget } from '@/lib/run-executor';
import { addSuppression } from '@/lib/suppressions';
import { createChannel, deleteChannel } from '@/lib/db/notification-channels';
import { setLinksForSchedule, deleteLinksForSchedule } from '@/lib/db/schedule-notification-channels';
import {
  setDnsLookupForTests, resetDnsLookupForTests, setGuardedTransportForTests, type GuardedTransport,
} from '@/lib/ssrf-guard';
import { resetDb, clearRules } from '../helpers/db';
import { argRow, TEST_SUB_A } from '../helpers/fake-azure';

const RULE_ID = 'suppressed-notify-rule';
const CATEGORY = 'security';
const MARKER = '// marker-suppressed-notify';
const DAY_MS = 24 * 60 * 60 * 1000;

async function insertRule(): Promise<void> {
  await execRun(db.insert(rulesTable).values({
    id: RULE_ID,
    name: RULE_ID,
    description: 'test rule',
    category: CATEGORY,
    severity: 'medium',
    enabled: true,
    scope: JSON.stringify({ level: 'subscription' }),
    resourceTypes: JSON.stringify([]),
    conditions: JSON.stringify([]),
    rawKql: `resources | where type == "microsoft.compute/virtualmachines" ${MARKER}`,
    type: 'custom',
  }));
}

/** A context whose query returns one row per named VM. */
function ctxWithVms(names: string[]): TenantContext {
  return {
    tenantId: 'test-tenant',
    subscriptionIds: [TEST_SUB_A],
    credential: {} as TokenCredential,
    log: () => {},
    async graphGet<TValue = Record<string, unknown>>(): Promise<TValue[]> {
      throw new Error('test ctx: graphGet should not be called in this ARG-only suite');
    },
    async queryLogs<TRow = Record<string, unknown>>(): Promise<TRow[]> {
      throw new Error('test ctx: queryLogs should not be called in this ARG-only suite');
    },
    async queryARG<TRow = Record<string, unknown>>(): Promise<TRow[]> {
      return names.map(name => argRow({ name })) as TRow[];
    },
  };
}

function fakeResponse(status: number): Response {
  return { ok: status >= 200 && status < 300, status, type: 'basic', text: async () => 'ok' } as Response;
}

describe('notifications leave out suppressed findings', () => {
  let scheduleId: string;
  let channelId: string;
  let fetchMock: ReturnType<typeof vi.fn<GuardedTransport>>;

  beforeEach(async () => {
    await resetDb();
    await clearRules();
    await insertRule();
    scheduleId = `sched-${crypto.randomUUID()}`;
    channelId = (await createChannel({ name: 'Test channel', type: 'webhook', url: 'https://example.test/hook' })).id;
    await setLinksForSchedule(scheduleId, [{ channelId, minSeverity: 'low', categoryIds: null, subscriptionIds: null }]);
    setDnsLookupForTests(async () => [{ address: '93.184.216.34' }]);
    fetchMock = vi.fn<GuardedTransport>().mockResolvedValue(fakeResponse(200));
    setGuardedTransportForTests(fetchMock);
  });

  afterEach(async () => {
    resetDnsLookupForTests();
    await deleteLinksForSchedule(scheduleId);
    await deleteChannel(channelId);
  });

  /** Fingerprints in every payload that reached the channel, in send order. */
  function sentFingerprints(): string[][] {
    return fetchMock.mock.calls.map(call => {
      const body = JSON.parse(String((call[1] as RequestInit).body)) as { findings: { fingerprint: string }[] };
      return body.findings.map(f => f.fingerprint);
    });
  }

  /** Scans `vm-old` once, so it exists as an active finding, then resolves it with an empty scan. */
  async function createAndResolveVm(): Promise<string> {
    await executeTarget(
      { targetType: 'categories', targetValues: [CATEGORY] },
      { triggeredBy: 'manual', ctx: ctxWithVms(['vm-old']) },
    );
    const fingerprint = (await listFindings({ status: 'active' }))[0]!.fingerprint;
    await executeTarget(
      { targetType: 'categories', targetValues: [CATEGORY] },
      { triggeredBy: 'manual', ctx: ctxWithVms([]) },
    );
    expect((await listFindings({ status: 'fixed' })).map(f => f.fingerprint)).toEqual([fingerprint]);
    return fingerprint;
  }

  async function suppress(fingerprint: string, expiresAt?: string): Promise<void> {
    await addSuppression({
      id: crypto.randomUUID(),
      fingerprint,
      reason: 'accepted risk',
      suppressedAt: new Date().toISOString(),
      ...(expiresAt ? { expiresAt } : {}),
    });
  }

  async function runScheduled(names: string[]) {
    const run = await executeTarget(
      { targetType: 'categories', targetValues: [CATEGORY] },
      { triggeredBy: 'schedule', scheduleId, ctx: ctxWithVms(names) },
    );
    // Dispatch is fired without being awaited; wait for the outbox row to close.
    await vi.waitFor(async () => expect((await getRun(run.id))!.notifyStatus).toBe('sent'));
    return run;
  }

  it('a reactivated suppressed finding is not in the dispatched payload, an unsuppressed new one still is', async () => {
    const suppressed = await createAndResolveVm();
    await suppress(suppressed);

    const run = await runScheduled(['vm-old', 'vm-new']);

    expect(run.newFindings).toBe(2); // the scan still counts both as new
    const fresh = (await listFindings({ status: 'active' })).map(f => f.fingerprint).filter(fp => fp !== suppressed);
    expect(fresh).toHaveLength(1);
    expect(sentFingerprints()).toEqual([fresh]);
  });

  it('a run whose only new finding is suppressed sends nothing and still closes the outbox', async () => {
    const suppressed = await createAndResolveVm();
    await suppress(suppressed);

    const run = await runScheduled(['vm-old']);

    expect(run.newFindings).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await getRun(run.id))!.notifyStatus).toBe('sent');
  });

  it('a suppression that has expired no longer hides the finding', async () => {
    const fingerprint = await createAndResolveVm();
    await suppress(fingerprint, new Date(Date.now() - DAY_MS).toISOString());

    await runScheduled(['vm-old']);

    expect(sentFingerprints()).toEqual([[fingerprint]]);
  });

  it('a suppression that expires in the future still hides the finding', async () => {
    const fingerprint = await createAndResolveVm();
    await suppress(fingerprint, new Date(Date.now() + DAY_MS).toISOString());

    await runScheduled(['vm-old']);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('startup recovery', () => {
    /** A scheduled run left pending for the given fingerprints, as a crash before dispatch leaves it. */
    async function pendingRunFor(fingerprints: string[]) {
      const run = await startRun({ scheduleId, triggeredBy: 'schedule', categories: [CATEGORY] });
      await finishRun(run.id, {
        status: 'success', totalFindings: fingerprints.length, newFindings: fingerprints.length,
        newFindingFingerprints: fingerprints, durationMs: 100, notifyStatus: 'pending',
      });
      return run;
    }

    async function activeFingerprints(names: string[]): Promise<string[]> {
      await executeTarget(
        { targetType: 'categories', targetValues: [CATEGORY] },
        { triggeredBy: 'manual', ctx: ctxWithVms(names) },
      );
      return (await listFindings({ status: 'active' })).map(f => f.fingerprint);
    }

    it('leaves a suppressed finding out of the recovered payload and sends the rest', async () => {
      const [first, second] = await activeFingerprints(['vm-a', 'vm-b']);
      await suppress(first!);
      const run = await pendingRunFor([first!, second!]);

      expect(await recoverPendingNotifications()).toBe(1);

      expect(sentFingerprints()).toEqual([[second]]);
      expect((await getRun(run.id))!.notifyStatus).toBe('sent');
    });

    it('sends nothing for a recovered run whose findings are all suppressed, and closes it', async () => {
      const [only] = await activeFingerprints(['vm-a']);
      await suppress(only!);
      const run = await pendingRunFor([only!]);

      expect(await recoverPendingNotifications()).toBe(1);

      expect(fetchMock).not.toHaveBeenCalled();
      expect((await getRun(run.id))!.notifyStatus).toBe('sent');
    });

    it('sends a recovered finding whose suppression has expired', async () => {
      const [only] = await activeFingerprints(['vm-a']);
      await suppress(only!, new Date(Date.now() - DAY_MS).toISOString());
      await pendingRunFor([only!]);

      await recoverPendingNotifications();

      expect(sentFingerprints()).toEqual([[only]]);
    });
  });
});
