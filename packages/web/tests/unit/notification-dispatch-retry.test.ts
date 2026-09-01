/**
 * dispatchNotifications' retry/backoff: transient failures (network errors, 429, 5xx) retry up to
 * 3 total attempts with backoff between them; a 4xx is never retried. Every outcome — success or
 * exhausted retries — must land exactly one row in notification_deliveries.
 *
 * Fake timers stand in for the real 2s/8s backoff delays so this suite runs in milliseconds, not
 * seconds; vi.advanceTimersByTimeAsync lets the awaited sleep() inside sendWithRetry resolve.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchNotifications } from '@/lib/notifications/dispatch';
import { createChannel, deleteChannel } from '@/lib/db/notification-channels';
import { deleteLinksForSchedule, setLinksForSchedule } from '@/lib/db/schedule-notification-channels';
import { listDeliveriesForChannel } from '@/lib/db/notification-deliveries';
import { setDnsLookupForTests, resetDnsLookupForTests } from '@/lib/ssrf-guard';
import type { ScheduleRun } from '@/lib/schedule-runs';
import type { Finding } from '@/lib/types';

function makeRun(scheduleId: string): ScheduleRun {
  return {
    id: 'run-1',
    scheduleId,
    triggeredBy: 'schedule',
    targetType: null,
    targetValues: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    categories: [],
    totalFindings: 1,
    newFindings: 1,
    newFindingFingerprints: [],
    error: null,
    durationMs: null,
    notifyStatus: 'pending',
  };
}

function makeFinding(): Finding {
  return {
    module: 'test',
    ruleId: 'rule-1',
    fingerprint: 'fp-1',
    severity: 'critical',
    category: 'security',
    resourceId: '/subscriptions/x/resourceGroups/y/providers/Microsoft.Compute/virtualMachines/vm1',
    resourceType: 'Microsoft.Compute/virtualMachines',
    resourceName: 'vm1',
    subscriptionId: 'sub-1',
    title: 'Test finding',
    description: 'desc',
    evidence: {},
    recommendation: 'fix it',
    remediationSteps: [],
    detectedAt: new Date().toISOString(),
  };
}

function fakeResponse(status: number, body = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as Response;
}

describe('dispatchNotifications retry/backoff', () => {
  let scheduleId: string;
  let channelId: string;

  beforeEach(async () => {
    scheduleId = `sched-${globalThis.crypto.randomUUID()}`;
    channelId = (await createChannel({ name: 'Test channel', type: 'webhook', url: 'https://example.test/hook' })).id;
    setLinksForSchedule(scheduleId, [{ channelId, minSeverity: 'low', categoryIds: null, subscriptionIds: null }]);
    vi.useFakeTimers();
    // spec 021: sendWebhook now SSRF-guards the destination before fetching, so example.test must
    // resolve to a public address via the injectable resolver instead of a real (and blocked) lookup.
    setDnsLookupForTests(async () => [{ address: '93.184.216.34' }]);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetDnsLookupForTests();
    deleteLinksForSchedule(scheduleId);
    await deleteChannel(channelId);
  });

  it('retries transient 500s with backoff, then records success on the attempt that works', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(fakeResponse(500, 'server error'))
      .mockResolvedValueOnce(fakeResponse(500, 'server error'))
      .mockResolvedValueOnce(fakeResponse(200, 'ok'));
    vi.stubGlobal('fetch', fetchMock);

    const promise = dispatchNotifications(makeRun(scheduleId), [makeFinding()]);
    await vi.advanceTimersByTimeAsync(2_000); // backoff before attempt 2
    await vi.advanceTimersByTimeAsync(8_000); // backoff before attempt 3
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(3);

    const history = await listDeliveriesForChannel(channelId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ ok: true, attempts: 3, httpStatus: 200 });
  });

  it('does not retry a 4xx — one attempt, one failed delivery row', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(400, 'bad request'));
    vi.stubGlobal('fetch', fetchMock);

    await dispatchNotifications(makeRun(scheduleId), [makeFinding()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const history = await listDeliveriesForChannel(channelId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ ok: false, attempts: 1, httpStatus: 400 });
    expect(history[0].error).toContain('400');
  });

  it('retries network errors up to 3 attempts, then records the final failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    const promise = dispatchNotifications(makeRun(scheduleId), [makeFinding()]);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(8_000);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(3);

    const history = await listDeliveriesForChannel(channelId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ ok: false, attempts: 3, httpStatus: null });
    expect(history[0].error).toContain('ECONNREFUSED');
  });

  it('spec 021: a channel resolving to a private address fails once, with no retries', async () => {
    setDnsLookupForTests(async () => [{ address: '169.254.169.254' }]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await dispatchNotifications(makeRun(scheduleId), [makeFinding()]);

    expect(fetchMock).not.toHaveBeenCalled();

    const history = await listDeliveriesForChannel(channelId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ ok: false, attempts: 1, httpStatus: null });
    expect(history[0].error).toMatch(/not a public address/i);
  });

  it('spec 021: a redirect response is refused once, with no retries', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 302, type: 'basic', ok: false } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await dispatchNotifications(makeRun(scheduleId), [makeFinding()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const history = await listDeliveriesForChannel(channelId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ ok: false, attempts: 1, httpStatus: null });
    expect(history[0].error).toMatch(/refusing to follow a redirect/i);
  });

  it('retries a 429 the same as a 5xx', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(fakeResponse(429, 'rate limited'))
      .mockResolvedValueOnce(fakeResponse(200, 'ok'));
    vi.stubGlobal('fetch', fetchMock);

    const promise = dispatchNotifications(makeRun(scheduleId), [makeFinding()]);
    await vi.advanceTimersByTimeAsync(2_000);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const history = await listDeliveriesForChannel(channelId);
    expect(history[0]).toMatchObject({ ok: true, attempts: 2, httpStatus: 200 });
  });
});
