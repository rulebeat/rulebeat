/**
 * Issue #176: an Advisory finding is never part of a notification. A channel cannot opt in to
 * Advisories yet, so a scheduled scan announces Problems and Activity only. The decision is made in
 * dispatchAndMarkSent(), which the live post-scan path and startup recovery both call, and a run
 * whose only new findings are Advisories does not even open an outbox entry.
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
import { createChannel, deleteChannel } from '@/lib/db/notification-channels';
import { setLinksForSchedule, deleteLinksForSchedule } from '@/lib/db/schedule-notification-channels';
import {
  setDnsLookupForTests, resetDnsLookupForTests, setGuardedTransportForTests, type GuardedTransport,
} from '@/lib/ssrf-guard';
import { resetDb, clearRules } from '../helpers/db';
import { argRow, TEST_SUB_A } from '../helpers/fake-azure';

const CATEGORY = 'security';
const PROBLEM_RULE = 'notify-problem-rule';
const ADVISORY_RULE = 'notify-advisory-rule';

async function insertRule(id: string, kind: 'state' | 'advisory'): Promise<void> {
  await execRun(db.insert(rulesTable).values({
    id,
    name: id,
    description: 'test rule',
    category: CATEGORY,
    severity: 'medium',
    enabled: true,
    kind,
    scope: JSON.stringify({ level: 'subscription' }),
    resourceTypes: JSON.stringify([]),
    conditions: JSON.stringify([]),
    rawKql: `resources | where type == "microsoft.compute/virtualmachines" // marker-${id}`,
    type: 'custom',
  }));
}

/** Rows returned per rule, keyed by the marker comment in the rule's query. */
function ctxWith(rowsByRule: Record<string, string[]>): TenantContext {
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
    async queryARG<TRow = Record<string, unknown>>(kql: string): Promise<TRow[]> {
      const id = Object.keys(rowsByRule).find(k => kql.includes(`marker-${k}`));
      return (id ? rowsByRule[id]! : []).map(name => argRow({ name })) as TRow[];
    },
  };
}

function fakeResponse(status: number): Response {
  return { ok: status >= 200 && status < 300, status, type: 'basic', text: async () => 'ok' } as Response;
}

describe('notifications leave out Advisory findings', () => {
  let scheduleId: string;
  let channelId: string;
  let fetchMock: ReturnType<typeof vi.fn<GuardedTransport>>;

  beforeEach(async () => {
    await resetDb();
    await clearRules();
    await insertRule(PROBLEM_RULE, 'state');
    await insertRule(ADVISORY_RULE, 'advisory');
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

  function sentFingerprints(): string[][] {
    return fetchMock.mock.calls.map(call => {
      const body = JSON.parse(String((call[1] as RequestInit).body)) as { findings: { fingerprint: string }[] };
      return body.findings.map(f => f.fingerprint);
    });
  }

  async function fingerprintsOfKind(kind: 'state' | 'advisory'): Promise<string[]> {
    return (await listFindings({ status: 'active', kinds: [kind] })).map(f => f.fingerprint);
  }

  it('sends the Problem finding and leaves the Advisory finding out of the same run', async () => {
    const run = await executeTarget(
      { targetType: 'categories', targetValues: [CATEGORY] },
      { triggeredBy: 'schedule', scheduleId, ctx: ctxWith({ [PROBLEM_RULE]: ['vm-p'], [ADVISORY_RULE]: ['vm-a1', 'vm-a2'] }) },
    );
    await vi.waitFor(async () => expect((await getRun(run.id))!.notifyStatus).toBe('sent'));

    expect(run.newFindings).toBe(3);
    expect(sentFingerprints()).toEqual([await fingerprintsOfKind('state')]);
  });

  it('opens no outbox entry and sends nothing when the only new findings are Advisories', async () => {
    const run = await executeTarget(
      { targetType: 'categories', targetValues: [CATEGORY] },
      { triggeredBy: 'schedule', scheduleId, ctx: ctxWith({ [ADVISORY_RULE]: ['vm-a1'] }) },
    );

    expect(run.newFindings).toBe(1);
    expect((await getRun(run.id))!.notifyStatus).toBe('none');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves an Advisory out of a recovered run and still closes it', async () => {
    await executeTarget(
      { targetType: 'categories', targetValues: [CATEGORY] },
      { triggeredBy: 'manual', ctx: ctxWith({ [PROBLEM_RULE]: ['vm-p'], [ADVISORY_RULE]: ['vm-a1'] }) },
    );
    const problem = await fingerprintsOfKind('state');
    const advisory = await fingerprintsOfKind('advisory');
    const pending = await startRun({ scheduleId, triggeredBy: 'schedule', categories: [CATEGORY] });
    await finishRun(pending.id, {
      status: 'success', totalFindings: 2, newFindings: 2,
      newFindingFingerprints: [...problem, ...advisory], durationMs: 100, notifyStatus: 'pending',
    });

    expect(await recoverPendingNotifications()).toBe(1);

    expect(sentFingerprints()).toEqual([problem]);
    expect((await getRun(pending.id))!.notifyStatus).toBe('sent');
  });

  it('closes a recovered run that holds only Advisories without sending', async () => {
    await executeTarget(
      { targetType: 'categories', targetValues: [CATEGORY] },
      { triggeredBy: 'manual', ctx: ctxWith({ [ADVISORY_RULE]: ['vm-a1'] }) },
    );
    const advisory = await fingerprintsOfKind('advisory');
    const pending = await startRun({ scheduleId, triggeredBy: 'schedule', categories: [CATEGORY] });
    await finishRun(pending.id, {
      status: 'success', totalFindings: 1, newFindings: 1,
      newFindingFingerprints: advisory, durationMs: 100, notifyStatus: 'pending',
    });

    expect(await recoverPendingNotifications()).toBe(1);

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await getRun(pending.id))!.notifyStatus).toBe('sent');
  });
});
