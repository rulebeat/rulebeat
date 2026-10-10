/**
 * Issue #180: a scheduled scan's new Advisories go only to channels whose "Include advisories"
 * setting is on, in their own section. Problems and Activity go to every channel as before, whatever
 * the setting. Suppressed Advisories are left out like suppressed problems. A run only opens an
 * outbox entry when some linked channel has something to receive.
 *
 * Driven through executeTarget() (the scheduled-run path) and recoverPendingNotifications() with the
 * fake Azure context; what was sent is read off the guarded transport, so no socket opens.
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
import { dispatchAndMarkSent } from '@/lib/notifications/dispatch';
import { createChannel, deleteChannel } from '@/lib/db/notification-channels';
import { listDeliveriesForChannel } from '@/lib/db/notification-deliveries';
import { setLinksForSchedule, deleteLinksForSchedule } from '@/lib/db/schedule-notification-channels';
import {
  setDnsLookupForTests, resetDnsLookupForTests, setGuardedTransportForTests, type GuardedTransport,
} from '@/lib/ssrf-guard';
import type { Finding, Severity } from '@/lib/types';
import { resetDb, clearRules } from '../helpers/db';
import { argRow, TEST_SUB_A } from '../helpers/fake-azure';

const CATEGORY = 'security';
const PROBLEM_RULE = 'notify-problem-rule';
const ADVISORY_RULE = 'notify-advisory-rule';
const DAY_MS = 24 * 60 * 60 * 1000;

async function insertRule(id: string, kind: 'state' | 'advisory', severity: Severity = 'medium'): Promise<void> {
  await execRun(db.insert(rulesTable).values({
    id,
    name: id,
    description: 'test rule',
    category: CATEGORY,
    severity,
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

interface SentBody {
  findings: { fingerprint: string; resourceName: string }[];
  advisories?: { totalNewAdvisories: number; findings: { fingerprint: string; resourceName: string }[]; advisoriesUrl: string };
  scansUrl: string;
  activity?: { totalNewActivity: number; findings: { resourceName: string }[]; activityUrl: string };
  changed?: { changedUrl: string; changedUrls: Record<string, string> };
}

describe('notification channels and Advisories', () => {
  let scheduleId: string;
  let onId: string;
  let offId: string;
  let fetchMock: ReturnType<typeof vi.fn<GuardedTransport>>;

  async function link(minSeverity: Severity = 'low', channels: string[] = [onId, offId]): Promise<void> {
    await setLinksForSchedule(scheduleId, channels.map(channelId => ({ channelId, minSeverity, categoryIds: null, subscriptionIds: null })));
  }

  beforeEach(async () => {
    await resetDb();
    await clearRules();
    await insertRule(PROBLEM_RULE, 'state');
    await insertRule(ADVISORY_RULE, 'advisory');
    scheduleId = `sched-${crypto.randomUUID()}`;
    onId = (await createChannel({ name: 'Advisory channel', type: 'webhook', url: 'https://example.test/on', includeAdvisories: true })).id;
    offId = (await createChannel({ name: 'Problems channel', type: 'webhook', url: 'https://example.test/off' })).id;
    await link();
    setDnsLookupForTests(async () => [{ address: '93.184.216.34' }]);
    fetchMock = vi.fn<GuardedTransport>().mockResolvedValue(fakeResponse(200));
    setGuardedTransportForTests(fetchMock);
  });

  afterEach(async () => {
    resetDnsLookupForTests();
    await deleteLinksForSchedule(scheduleId);
    await deleteChannel(onId);
    await deleteChannel(offId);
  });

  /** Every body sent to the channel whose URL ends in `path`, in send order. */
  function sentTo(path: 'on' | 'off'): SentBody[] {
    return fetchMock.mock.calls
      .filter(call => String(call[0]).endsWith(`/${path}`))
      .map(call => JSON.parse(String((call[1] as RequestInit).body)) as SentBody);
  }

  const names = (list: { resourceName: string }[]) => list.map(f => f.resourceName).sort();

  async function runScheduled(rowsByRule: Record<string, string[]>) {
    const run = await executeTarget(
      { targetType: 'categories', targetValues: [CATEGORY] },
      { triggeredBy: 'schedule', scheduleId, ctx: ctxWith(rowsByRule) },
    );
    await vi.waitFor(async () => expect((await getRun(run.id))!.notifyStatus).toBe('sent'));
    return run;
  }

  async function fingerprintsOf(resourceName: string): Promise<string> {
    const found = (await listFindings({ status: 'active' })).find(f => f.resourceName === resourceName);
    return found!.fingerprint;
  }

  describe('a scan with new Problems and new Advisories', () => {
    it('sends Advisories only to the channel that includes them, in their own section', async () => {
      await runScheduled({ [PROBLEM_RULE]: ['vm-p'], [ADVISORY_RULE]: ['vm-a1', 'vm-a2'] });

      const [onBody] = sentTo('on');
      expect(sentTo('on')).toHaveLength(1);
      expect(names(onBody!.findings)).toEqual(['vm-p']);
      expect(names(onBody!.advisories!.findings)).toEqual(['vm-a1', 'vm-a2']);
      expect(onBody!.advisories!.totalNewAdvisories).toBe(2);
      expect(onBody!.advisories!.advisoriesUrl).toContain('tab=advisories');
    });

    it('sends the Problems unchanged to both channels and nothing about Advisories to the other', async () => {
      await runScheduled({ [PROBLEM_RULE]: ['vm-p'], [ADVISORY_RULE]: ['vm-a1', 'vm-a2'] });

      const [onBody] = sentTo('on');
      const [offBody] = sentTo('off');
      expect(sentTo('off')).toHaveLength(1);
      expect(names(offBody!.findings)).toEqual(['vm-p']);
      expect(offBody!.findings).toEqual(onBody!.findings);
      expect(Object.keys(offBody!)).toEqual(['event', 'runId', 'triggeredBy', 'counts', 'totalNewFindings', 'findings', 'scansUrl']);
    });

    it('counts the Advisories in the delivery the channel records, and only for the channel that got them', async () => {
      await runScheduled({ [PROBLEM_RULE]: ['vm-p'], [ADVISORY_RULE]: ['vm-a1', 'vm-a2'] });

      expect((await listDeliveriesForChannel(onId)).map(d => d.findingsCount)).toEqual([3]);
      expect((await listDeliveriesForChannel(offId)).map(d => d.findingsCount)).toEqual([1]);
    });

    it('applies the channel\'s severity threshold to Advisories as it does to Problems', async () => {
      await clearRules();
      await insertRule(PROBLEM_RULE, 'state', 'medium');
      await insertRule(ADVISORY_RULE, 'advisory', 'high');
      await link('high');

      await runScheduled({ [PROBLEM_RULE]: ['vm-p'], [ADVISORY_RULE]: ['vm-a1'] });

      const [onBody] = sentTo('on');
      expect(onBody!.findings).toEqual([]);
      expect(names(onBody!.advisories!.findings)).toEqual(['vm-a1']);
      expect(sentTo('off')).toEqual([]);
    });
  });

  describe('a scan whose only new findings are Advisories', () => {
    it('sends a message holding only the Advisories to the channel that includes them, and nothing to the other', async () => {
      const run = await runScheduled({ [ADVISORY_RULE]: ['vm-a1'] });

      expect(run.newFindings).toBe(1);
      const [onBody] = sentTo('on');
      expect(onBody!.findings).toEqual([]);
      expect(names(onBody!.advisories!.findings)).toEqual(['vm-a1']);
      expect(sentTo('off')).toEqual([]);
      expect(await listDeliveriesForChannel(offId)).toEqual([]);
    });

    it('opens no outbox entry when no linked channel includes Advisories', async () => {
      await link('low', [offId]);

      const run = await executeTarget(
        { targetType: 'categories', targetValues: [CATEGORY] },
        { triggeredBy: 'schedule', scheduleId, ctx: ctxWith({ [ADVISORY_RULE]: ['vm-a1'] }) },
      );

      expect((await getRun(run.id))!.notifyStatus).toBe('none');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('opens no outbox entry when the channel that includes Advisories is not linked to the schedule', async () => {
      await link('low', [offId]);
      const otherSchedule = `sched-${crypto.randomUUID()}`;
      await setLinksForSchedule(otherSchedule, [{ channelId: onId, minSeverity: 'low', categoryIds: null, subscriptionIds: null }]);

      const run = await executeTarget(
        { targetType: 'categories', targetValues: [CATEGORY] },
        { triggeredBy: 'schedule', scheduleId, ctx: ctxWith({ [ADVISORY_RULE]: ['vm-a1'] }) },
      );
      await deleteLinksForSchedule(otherSchedule);

      expect((await getRun(run.id))!.notifyStatus).toBe('none');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('a channel with the setting on and no new Advisories', () => {
    it('gets exactly the message a channel without the setting gets', async () => {
      await runScheduled({ [PROBLEM_RULE]: ['vm-p'] });

      const [onBody] = sentTo('on');
      const [offBody] = sentTo('off');
      expect(Object.keys(onBody!)).toEqual(['event', 'runId', 'triggeredBy', 'counts', 'totalNewFindings', 'findings', 'scansUrl']);
      expect(onBody).toEqual(offBody);
    });
  });

  describe('suppressed Advisories', () => {
    /** Scans the Advisory once so it exists, then resolves it, so a later scan reactivates it as new. */
    async function createAndResolveAdvisory(resourceName: string): Promise<string> {
      await executeTarget(
        { targetType: 'categories', targetValues: [CATEGORY] },
        { triggeredBy: 'manual', ctx: ctxWith({ [ADVISORY_RULE]: [resourceName] }) },
      );
      const fingerprint = await fingerprintsOf(resourceName);
      await executeTarget(
        { targetType: 'categories', targetValues: [CATEGORY] },
        { triggeredBy: 'manual', ctx: ctxWith({}) },
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

    it('leaves a suppressed Advisory out, and still sends an unsuppressed new one', async () => {
      await suppress(await createAndResolveAdvisory('vm-old'));

      await runScheduled({ [ADVISORY_RULE]: ['vm-old', 'vm-new'] });

      const [onBody] = sentTo('on');
      expect(names(onBody!.advisories!.findings)).toEqual(['vm-new']);
    });

    it('sends nothing, and still closes the run, when every new Advisory is suppressed', async () => {
      await suppress(await createAndResolveAdvisory('vm-old'));

      await runScheduled({ [ADVISORY_RULE]: ['vm-old'] });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sends an Advisory whose suppression has expired', async () => {
      await suppress(await createAndResolveAdvisory('vm-old'), new Date(Date.now() - DAY_MS).toISOString());

      await runScheduled({ [ADVISORY_RULE]: ['vm-old'] });

      expect(names(sentTo('on')[0]!.advisories!.findings)).toEqual(['vm-old']);
    });
  });

  describe('a recovered run', () => {
    it('sends the Advisories to the channel that includes them and the Problems to both', async () => {
      await executeTarget(
        { targetType: 'categories', targetValues: [CATEGORY] },
        { triggeredBy: 'manual', ctx: ctxWith({ [PROBLEM_RULE]: ['vm-p'], [ADVISORY_RULE]: ['vm-a1'] }) },
      );
      const problem = await fingerprintsOf('vm-p');
      const advisory = await fingerprintsOf('vm-a1');
      const pending = await startRun({ scheduleId, triggeredBy: 'schedule', categories: [CATEGORY] });
      await finishRun(pending.id, {
        status: 'success', totalFindings: 2, newFindings: 2,
        newFindingFingerprints: [problem, advisory], durationMs: 100, notifyStatus: 'pending',
      });

      expect(await recoverPendingNotifications()).toBe(1);

      expect(names(sentTo('on')[0]!.findings)).toEqual(['vm-p']);
      expect(names(sentTo('on')[0]!.advisories!.findings)).toEqual(['vm-a1']);
      expect(names(sentTo('off')[0]!.findings)).toEqual(['vm-p']);
      expect(sentTo('off')[0]!.advisories).toBeUndefined();
      expect((await getRun(pending.id))!.notifyStatus).toBe('sent');
    });
  });

  describe('Activity findings', () => {
    const activityFinding = (resourceName: string) => ({
      module: 'test', ruleId: 'law-rule', fingerprint: `fp-${resourceName}`, severity: 'medium', category: CATEGORY, kind: 'activity',
      resourceId: `law:${resourceName}`, resourceType: 'activity', resourceName, subscriptionId: TEST_SUB_A,
      resourceGroup: '', location: '', title: 'Sign-in burst', description: '', recommendation: '',
      remediationSteps: [], evidence: {}, detectedAt: new Date().toISOString(),
    }) as unknown as Finding;

    async function pendingRun() {
      const pending = await startRun({ scheduleId, triggeredBy: 'schedule', categories: [CATEGORY] });
      await finishRun(pending.id, {
        status: 'success', totalFindings: 1, newFindings: 1,
        newFindingFingerprints: ['fp-burst'], durationMs: 100, notifyStatus: 'pending',
      });
      return (await getRun(pending.id))!;
    }

    it('arrive in their own section on every channel, linked to the new findings on the Activity tab', async () => {
      expect(await dispatchAndMarkSent(await pendingRun(), [activityFinding('burst')])).toBe(true);

      for (const path of ['on', 'off'] as const) {
        const [body] = sentTo(path);
        expect(body!.activity!.findings.map(f => f.resourceName)).toEqual(['burst']);
        expect(body!.activity!.activityUrl).toBe(body!.scansUrl.replace('tab=results', 'tab=activity'));
        expect(body!.activity!.activityUrl).toContain('tab=activity&status=new');
      }
    });

    it('link a changed Activity finding to the open findings on the Activity tab, and a changed Problem to Results', async () => {
      const problem = { ...activityFinding('vm-p'), kind: 'state', resourceId: '/subscriptions/s/vm-p' } as Finding;
      const changed = [
        { ...activityFinding('burst'), addedRows: [{ user: 'a' }] },
        { ...problem, addedRows: [{ retirement: 'TLS 1.0' }] },
      ];

      expect(await dispatchAndMarkSent(await pendingRun(), [], { changed })).toBe(true);

      const [body] = sentTo('off');
      expect(body!.changed!.changedUrl).toContain('tab=results&status=open');
      expect(Object.keys(body!.changed!.changedUrls)).toEqual(['results', 'activity']);
      expect(body!.changed!.changedUrls.activity).toContain('tab=activity&status=open');
    });

    it('go to every channel whatever the setting', async () => {
      const activity = {
        module: 'test', ruleId: 'law-rule', fingerprint: 'fp-activity', severity: 'medium', category: CATEGORY, kind: 'activity',
        resourceId: 'law:row-1', resourceType: 'activity', resourceName: 'sign-in-burst', subscriptionId: TEST_SUB_A,
        resourceGroup: '', location: '', title: 'Sign-in burst', description: '', recommendation: '',
        remediationSteps: [], evidence: {}, detectedAt: new Date().toISOString(),
      } as unknown as Finding;
      const pending = await startRun({ scheduleId, triggeredBy: 'schedule', categories: [CATEGORY] });
      await finishRun(pending.id, {
        status: 'success', totalFindings: 1, newFindings: 1,
        newFindingFingerprints: ['fp-activity'], durationMs: 100, notifyStatus: 'pending',
      });

      expect(await dispatchAndMarkSent((await getRun(pending.id))!, [activity])).toBe(true);

      expect(names(sentTo('on')[0]!.findings)).toEqual(['sign-in-burst']);
      expect(names(sentTo('off')[0]!.findings)).toEqual(['sign-in-burst']);
      expect(sentTo('on')[0]!.advisories).toBeUndefined();
    });
  });
});
