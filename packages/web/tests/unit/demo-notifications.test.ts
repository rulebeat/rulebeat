/**
 * A Demo never sends a notification. Scheduled dispatch records what it would have sent as
 * suppressed, and "Send test" answers without contacting anything, whatever URL or SMTP host a
 * Visitor typed. `fetch` and nodemailer are spied on so "never contacted" is observed, not assumed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { users } from '@/lib/db/tables';
import { eq } from 'drizzle-orm';
import { createUser } from '@/lib/db/users';
import { deleteMeta } from '@/lib/db/meta';
import { createChannel, getChannelSummary } from '@/lib/db/notification-channels';
import { setLinksForSchedule } from '@/lib/db/schedule-notification-channels';
import { listDeliveriesForChannel } from '@/lib/db/notification-deliveries';
import { setDnsLookupForTests, resetDnsLookupForTests, setGuardedTransportForTests } from '@/lib/ssrf-guard';
import { DEMO_VISITOR_ID, resetDemoModeCacheForTests, stampDemoDatabase } from '@/lib/demo';
import type { ScheduleRun } from '@/lib/schedule-runs';
import type { Finding } from '@/lib/types';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const sendMail = vi.fn();
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail }) } }));

const { dispatchNotifications, DEMO_NOT_SENT } = await import('@/lib/notifications/dispatch');
const { POST: TEST_POST } = await import('@/app/api/settings/notifications/test/route');

const fetchSpy = vi.fn(async () => new Response('ok', { status: 200 }));

const RUN: ScheduleRun = {
  id: 'run-1', scheduleId: 'sched-1', triggeredBy: 'schedule', targetType: null, targetValues: [],
  startedAt: new Date().toISOString(), finishedAt: null, status: 'running', categories: [],
  totalFindings: 1, newFindings: 1, newFindingFingerprints: [], error: null, durationMs: null,
  notifyStatus: 'pending', notifyClaimedAt: null, heartbeatAt: null, ownerId: null,
  changedFindings: [],
};

const FINDING: Finding = {
  module: 'test', ruleId: 'rule-1', fingerprint: 'fp-1', severity: 'critical', category: 'security',
  resourceId: '/subscriptions/x/resourceGroups/y/providers/Microsoft.Compute/virtualMachines/vm1',
  resourceType: 'Microsoft.Compute/virtualMachines', resourceName: 'vm1', subscriptionId: 'sub-1',
  title: 'Test finding', description: 'desc', evidence: {}, recommendation: 'fix it',
  remediationSteps: [], detectedAt: new Date().toISOString(),
};

async function enableDemo(): Promise<void> {
  const result = await createUser({ email: 'demo-visitor@rulebeat.local', role: 'admin' });
  if ('error' in result) throw new Error(result.error);
  await execRun(db.update(users).set({ id: DEMO_VISITOR_ID }).where(eq(users.id, result.user.id)));
  process.env.RULEBEAT_DEMO = '1';
  await stampDemoDatabase();
  resetDemoModeCacheForTests();
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  mockAuth.mockResolvedValue(null);
  sendMail.mockReset();
  fetchSpy.mockClear();
  setGuardedTransportForTests(fetchSpy);
  setDnsLookupForTests(async () => [{ address: '93.184.216.34' }]);
  await enableDemo();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  resetDnsLookupForTests();
  delete process.env.RULEBEAT_DEMO;
  await deleteMeta('demo-mode-v2');
  resetDemoModeCacheForTests();
});

describe('scheduled dispatch in a Demo', () => {
  it('sends nothing and records each delivery that would have gone out as suppressed', async () => {
    const webhook = await createChannel({ name: 'Hook', type: 'webhook', url: 'https://example.test/hook' });
    const email = await createChannel({
      name: 'Mail', type: 'email', url: 'smtp-password',
      config: { host: 'smtp.example.test', port: 587, tls: 'starttls', username: 'u', fromAddress: 'a@example.test', toAddresses: 'b@example.test' },
    });
    await setLinksForSchedule(RUN.scheduleId, [
      { channelId: webhook.id, minSeverity: 'low', categoryIds: null, subscriptionIds: null },
      { channelId: email.id, minSeverity: 'low', categoryIds: null, subscriptionIds: null },
    ]);

    await dispatchNotifications(RUN, [FINDING]);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
    for (const channel of [webhook, email]) {
      const [delivery] = await listDeliveriesForChannel(channel.id);
      expect(delivery).toMatchObject({ suppressed: true, ok: false, attempts: 0, error: DEMO_NOT_SENT, findingsCount: 1 });
      // The channel was never contacted, so its own last result is untouched.
      expect((await getChannelSummary(channel.id))?.lastError ?? null).toBeNull();
    }
  });

  it('still sends outside a Demo, so the suppression is the Demo check and not a broken channel', async () => {
    delete process.env.RULEBEAT_DEMO;
    resetDemoModeCacheForTests();
    const webhook = await createChannel({ name: 'Hook', type: 'webhook', url: 'https://example.test/hook' });
    await setLinksForSchedule(RUN.scheduleId, [{ channelId: webhook.id, minSeverity: 'low', categoryIds: null, subscriptionIds: null }]);

    await dispatchNotifications(RUN, [FINDING]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [delivery] = await listDeliveriesForChannel(webhook.id);
    expect(delivery).toMatchObject({ suppressed: false, ok: true });
  });
});

describe('"Send test" in a Demo', () => {
  function testRequest(body: unknown): Request {
    return new Request('http://localhost/api/settings/notifications/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('answers "Not sent" for a saved channel without contacting it', async () => {
    const webhook = await createChannel({ name: 'Hook', type: 'webhook', url: 'https://example.test/hook' });
    const res = await TEST_POST(testRequest({ id: webhook.id }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: DEMO_NOT_SENT });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers "Not sent" for values typed into the form, webhook or SMTP, without contacting either', async () => {
    const hook = await TEST_POST(testRequest({ type: 'webhook', url: 'https://example.test/hook' }));
    const mail = await TEST_POST(testRequest({
      type: 'email', url: 'pw',
      config: { host: 'smtp.example.test', port: 587, tls: 'starttls', username: '', fromAddress: 'a@example.test', toAddresses: 'b@example.test' },
    }));
    for (const res of [hook, mail]) {
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(DEMO_NOT_SENT);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });
});
