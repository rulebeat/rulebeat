/**
 * Issue #193: a scheduled scan that finds an open finding has gained a Row notifies about it, in a
 * "Changed" section listing the added rows. A lost row never notifies. The same suppression, scope,
 * severity and "Include advisories" rules apply as for a new finding, a manual run never notifies,
 * and a run that crashes after recording a changed finding still sends it on recovery.
 *
 * Driven through executeTarget() (the scheduled-run path) over the fake Azure context; what was sent
 * is read off the guarded transport, so no socket opens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenCredential } from '@azure/identity';
import type { TenantContext } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { rules as rulesTable } from '@/lib/db/tables';
import { listFindings } from '@/lib/db/findings';
import { startRun, finishRun, getRun, recordCategoryProgress } from '@/lib/schedule-runs';
import { recoverInterruptedRuns, recoverPendingNotifications } from '@/lib/startup-recovery';
import { executeTarget } from '@/lib/run-executor';
import { addSuppression } from '@/lib/suppressions';
import { createChannel, deleteChannel } from '@/lib/db/notification-channels';
import { listDeliveriesForChannel } from '@/lib/db/notification-deliveries';
import { setLinksForSchedule, deleteLinksForSchedule } from '@/lib/db/schedule-notification-channels';
import {
  setDnsLookupForTests, resetDnsLookupForTests, setGuardedTransportForTests, type GuardedTransport,
} from '@/lib/ssrf-guard';
import type { Severity } from '@/lib/types';
import { resetDb, clearRules } from '../helpers/db';
import { argRow, TEST_SUB_A } from '../helpers/fake-azure';

const CATEGORY = 'security';
const PROBLEM_RULE = 'changed-problem-rule';
const ADVISORY_RULE = 'changed-advisory-rule';
const BASE_KQL = 'resources | where type == "microsoft.compute/virtualmachines"';

/** One row a rule returns: the resource's name, and the column whose value makes the row distinct. */
interface Result { name: string; retirement: string }

async function insertRule(id: string, kind: 'state' | 'advisory', severity: Severity = 'medium', kql = BASE_KQL): Promise<void> {
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
    rawKql: `${kql} // marker-${id}`,
    type: 'custom',
  }));
}

function ctxWith(resultsByRule: Record<string, Result[]>, opts: { failing?: boolean } = {}): TenantContext {
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
      if (opts.failing) throw new Error('test ctx: the query failed');
      const id = Object.keys(resultsByRule).find(k => kql.includes(`marker-${k}`));
      return (id ? resultsByRule[id]! : []).map(({ name, retirement }) => ({ ...argRow({ name }), retirement })) as TRow[];
    },
  };
}

function fakeResponse(status: number): Response {
  return { ok: status >= 200 && status < 300, status, type: 'basic', text: async () => 'ok' } as Response;
}

interface SentBody {
  totalNewFindings: number;
  findings: { resourceName: string }[];
  advisories?: unknown;
  changed?: {
    totalChangedFindings: number;
    findings: { fingerprint: string; resourceName: string; addedRows: Record<string, unknown>[] }[];
    changedUrl: string;
  };
}

const BASIC: Result = { name: 'vm-1', retirement: 'Basic tier' };
const TLS: Result = { name: 'vm-1', retirement: 'TLS 1.0' };

describe('changed findings in a scheduled scan', () => {
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

  function sentTo(path: 'on' | 'off'): SentBody[] {
    return fetchMock.mock.calls
      .filter(call => String(call[0]).endsWith(`/${path}`))
      .map(call => JSON.parse(String((call[1] as RequestInit).body)) as SentBody);
  }

  /** The first scan, run by hand so it announces nothing: it only gives the findings their first rows. */
  async function seed(resultsByRule: Record<string, Result[]>): Promise<void> {
    await executeTarget(
      { targetType: 'categories', targetValues: [CATEGORY] },
      { triggeredBy: 'manual', ctx: ctxWith(resultsByRule) },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  }

  async function runScheduled(ctx: TenantContext) {
    return executeTarget(
      { targetType: 'categories', targetValues: [CATEGORY] },
      { triggeredBy: 'schedule', scheduleId, ctx },
    );
  }

  async function runScheduledAndWait(resultsByRule: Record<string, Result[]>) {
    const run = await runScheduled(ctxWith(resultsByRule));
    await vi.waitFor(async () => expect((await getRun(run.id))!.notifyStatus).toBe('sent'));
    return run;
  }

  async function fingerprintOf(resourceName: string): Promise<string> {
    return (await listFindings({ status: 'active' })).find(f => f.resourceName === resourceName)!.fingerprint;
  }

  describe('a second scan that returns an extra row for an open finding', () => {
    it('sends a Changed section listing the added row, to both channels', async () => {
      await seed({ [PROBLEM_RULE]: [BASIC] });

      const run = await runScheduledAndWait({ [PROBLEM_RULE]: [BASIC, TLS] });

      expect(run.newFindings).toBe(0);
      for (const path of ['on', 'off'] as const) {
        expect(sentTo(path)).toHaveLength(1);
        const [body] = sentTo(path);
        expect(body!.findings).toEqual([]);
        expect(body!.totalNewFindings).toBe(0);
        expect(body!.changed!.totalChangedFindings).toBe(1);
        expect(body!.changed!.findings).toEqual([{
          fingerprint: await fingerprintOf('vm-1'),
          title: PROBLEM_RULE,
          severity: 'medium',
          category: CATEGORY,
          resourceId: expect.stringContaining('vm-1'),
          resourceName: 'vm-1',
          subscriptionId: TEST_SUB_A,
          addedRows: [{ retirement: 'TLS 1.0' }],
        }]);
        expect(body!.changed!.changedUrl).toContain('status=open');
      }
    });

    it('counts the changed finding in the delivery each channel records', async () => {
      await seed({ [PROBLEM_RULE]: [BASIC] });

      await runScheduledAndWait({ [PROBLEM_RULE]: [BASIC, TLS] });

      expect((await listDeliveriesForChannel(onId)).map(d => d.findingsCount)).toEqual([1]);
      expect((await listDeliveriesForChannel(offId)).map(d => d.findingsCount)).toEqual([1]);
    });

    it('adds the changed finding to the new ones in one message, and counts both', async () => {
      await seed({ [PROBLEM_RULE]: [BASIC] });

      await runScheduledAndWait({ [PROBLEM_RULE]: [BASIC, TLS, { name: 'vm-2', retirement: 'Basic tier' }] });

      const [body] = sentTo('off');
      expect(body!.findings.map(f => f.resourceName)).toEqual(['vm-2']);
      expect(body!.changed!.findings.map(f => f.resourceName)).toEqual(['vm-1']);
      expect((await listDeliveriesForChannel(offId)).map(d => d.findingsCount)).toEqual([2]);
    });

    it('records the run as holding a changed finding even though it has none new', async () => {
      await seed({ [PROBLEM_RULE]: [BASIC] });

      const run = await runScheduledAndWait({ [PROBLEM_RULE]: [BASIC, TLS] });

      expect((await getRun(run.id))!.changedFindings).toEqual([
        { fingerprint: await fingerprintOf('vm-1'), addedRows: [{ retirement: 'TLS 1.0' }] },
      ]);
    });

    it('does not notify the next scan again when nothing else changed', async () => {
      await seed({ [PROBLEM_RULE]: [BASIC] });
      await runScheduledAndWait({ [PROBLEM_RULE]: [BASIC, TLS] });
      fetchMock.mockClear();

      const run = await runScheduled(ctxWith({ [PROBLEM_RULE]: [BASIC, TLS] }));

      expect((await getRun(run.id))!.notifyStatus).toBe('none');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('a row that is lost or whose value changed', () => {
    it('does not notify when a row is lost', async () => {
      await seed({ [PROBLEM_RULE]: [BASIC, TLS] });

      const run = await runScheduled(ctxWith({ [PROBLEM_RULE]: [BASIC] }));

      expect((await getRun(run.id))!.notifyStatus).toBe('none');
      expect((await getRun(run.id))!.changedFindings).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('lists only the new value when a row\'s value changed', async () => {
      await seed({ [PROBLEM_RULE]: [BASIC] });

      await runScheduledAndWait({ [PROBLEM_RULE]: [TLS] });

      const [body] = sentTo('off');
      expect(body!.changed!.findings[0]!.addedRows).toEqual([{ retirement: 'TLS 1.0' }]);
    });
  });

  describe('a scan that did not finish the rule', () => {
    it('does not notify when the rule\'s query failed', async () => {
      await seed({ [PROBLEM_RULE]: [BASIC] });

      const run = await runScheduled(ctxWith({}, { failing: true }));

      expect((await getRun(run.id))!.notifyStatus).toBe('none');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not notify when the rule\'s result was capped', async () => {
      await clearRules();
      await insertRule(PROBLEM_RULE, 'state', 'medium', `${BASE_KQL} | take 100`);
      await seed({ [PROBLEM_RULE]: [BASIC] });

      const run = await runScheduled(ctxWith({ [PROBLEM_RULE]: [BASIC, TLS] }));

      expect((await getRun(run.id))!.notifyStatus).toBe('none');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('a manual run', () => {
    it('does not notify about a changed finding', async () => {
      await seed({ [PROBLEM_RULE]: [BASIC] });

      const run = await executeTarget(
        { targetType: 'categories', targetValues: [CATEGORY] },
        { triggeredBy: 'manual', ctx: ctxWith({ [PROBLEM_RULE]: [BASIC, TLS] }) },
      );

      expect((await getRun(run.id))!.notifyStatus).toBe('none');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('suppression', () => {
    it('leaves a suppressed changed finding out, and still closes the run', async () => {
      await seed({ [PROBLEM_RULE]: [BASIC] });
      await addSuppression({
        id: crypto.randomUUID(),
        fingerprint: await fingerprintOf('vm-1'),
        reason: 'accepted risk',
        suppressedAt: new Date().toISOString(),
      });

      await runScheduledAndWait({ [PROBLEM_RULE]: [BASIC, TLS] });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('still sends an unsuppressed changed finding beside a suppressed one', async () => {
      await seed({ [PROBLEM_RULE]: [BASIC, { name: 'vm-2', retirement: 'Basic tier' }] });
      await addSuppression({
        id: crypto.randomUUID(),
        fingerprint: await fingerprintOf('vm-1'),
        reason: 'accepted risk',
        suppressedAt: new Date().toISOString(),
      });

      await runScheduledAndWait({ [PROBLEM_RULE]: [BASIC, TLS, { name: 'vm-2', retirement: 'Basic tier' }, { name: 'vm-2', retirement: 'TLS 1.0' }] });

      expect(sentTo('off')[0]!.changed!.findings.map(f => f.resourceName)).toEqual(['vm-2']);
    });
  });

  describe('a changed Advisory', () => {
    it('reaches only the channel that includes advisories', async () => {
      await seed({ [ADVISORY_RULE]: [BASIC] });

      await runScheduledAndWait({ [ADVISORY_RULE]: [BASIC, TLS] });

      expect(sentTo('on')[0]!.changed!.findings.map(f => f.resourceName)).toEqual(['vm-1']);
      expect(sentTo('off')).toEqual([]);
      expect(await listDeliveriesForChannel(offId)).toEqual([]);
    });

    it('links to the open findings on the Advisories tab, not to Results', async () => {
      await seed({ [ADVISORY_RULE]: [BASIC] });

      await runScheduledAndWait({ [ADVISORY_RULE]: [BASIC, TLS] });

      expect(sentTo('on')[0]!.changed!.changedUrl).toContain('tab=advisories&status=open');
    });

    it('opens no outbox entry when no linked channel includes advisories', async () => {
      await seed({ [ADVISORY_RULE]: [BASIC] });
      await link('low', [offId]);

      const run = await runScheduled(ctxWith({ [ADVISORY_RULE]: [BASIC, TLS] }));

      expect((await getRun(run.id))!.notifyStatus).toBe('none');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sends a changed Problem to the other channel while the Advisory stays with the first', async () => {
      await seed({ [PROBLEM_RULE]: [BASIC], [ADVISORY_RULE]: [{ name: 'vm-a', retirement: 'Basic tier' }] });

      await runScheduledAndWait({ [PROBLEM_RULE]: [BASIC, TLS], [ADVISORY_RULE]: [{ name: 'vm-a', retirement: 'Basic tier' }, { name: 'vm-a', retirement: 'TLS 1.0' }] });

      expect(sentTo('on')[0]!.changed!.findings.map(f => f.resourceName).sort()).toEqual(['vm-1', 'vm-a']);
      expect(sentTo('off')[0]!.changed!.findings.map(f => f.resourceName)).toEqual(['vm-1']);
    });
  });

  describe('severity threshold and scope', () => {
    it('leaves a changed finding below the channel\'s severity threshold out', async () => {
      await link('high');
      await seed({ [PROBLEM_RULE]: [BASIC] });

      await runScheduledAndWait({ [PROBLEM_RULE]: [BASIC, TLS] });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('leaves a changed finding outside the channel\'s category out', async () => {
      await setLinksForSchedule(scheduleId, [{ channelId: offId, minSeverity: 'low', categoryIds: ['cost'], subscriptionIds: null }]);
      await seed({ [PROBLEM_RULE]: [BASIC] });

      await runScheduledAndWait({ [PROBLEM_RULE]: [BASIC, TLS] });

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('a run that crashed', () => {
    const OLD = () => new Date(Date.now() - 60 * 60_000);

    it('sends the changed finding recorded before the crash, after both recovery passes', async () => {
      await seed({ [PROBLEM_RULE]: [BASIC, TLS] });
      const fingerprint = await fingerprintOf('vm-1');
      const crashed = await startRun({ scheduleId, triggeredBy: 'schedule', categories: [CATEGORY], now: OLD() });
      await recordCategoryProgress(crashed.id, {
        totalFindings: 1, newFindings: 0, newFindingFingerprints: [],
        changedFindings: [{ fingerprint, addedRows: [{ retirement: 'TLS 1.0' }] }],
      });

      expect(await recoverInterruptedRuns()).toBe(1);
      expect((await getRun(crashed.id))!.notifyStatus).toBe('pending');
      expect(await recoverPendingNotifications()).toBe(1);

      expect(sentTo('off')).toHaveLength(1);
      expect(sentTo('off')[0]!.changed!.findings).toEqual([expect.objectContaining({
        fingerprint, resourceName: 'vm-1', addedRows: [{ retirement: 'TLS 1.0' }],
      })]);
      expect((await getRun(crashed.id))!.notifyStatus).toBe('sent');
    });

    it('sends the changed finding of a finished run whose dispatch never happened', async () => {
      await seed({ [PROBLEM_RULE]: [BASIC, TLS] });
      const fingerprint = await fingerprintOf('vm-1');
      const pending = await startRun({ scheduleId, triggeredBy: 'schedule', categories: [CATEGORY] });
      await finishRun(pending.id, {
        status: 'success', totalFindings: 1, newFindings: 0, newFindingFingerprints: [], durationMs: 100,
        notifyStatus: 'pending', changedFindings: [{ fingerprint, addedRows: [{ retirement: 'TLS 1.0' }] }],
      });

      expect(await recoverPendingNotifications()).toBe(1);

      expect(sentTo('on')[0]!.changed!.findings.map(f => f.resourceName)).toEqual(['vm-1']);
    });

    it('leaves a run with nothing recorded alone', async () => {
      const crashed = await startRun({ scheduleId, triggeredBy: 'schedule', categories: [CATEGORY], now: OLD() });

      expect(await recoverInterruptedRuns()).toBe(1);

      expect((await getRun(crashed.id))!.notifyStatus).toBe('none');
    });
  });

  describe('recording progress per category', () => {
    it('merges a finding recorded twice into one, with every row it gained', async () => {
      const started = await startRun({ scheduleId, triggeredBy: 'schedule', categories: [CATEGORY] });

      await recordCategoryProgress(started.id, {
        totalFindings: 1, newFindings: 0, newFindingFingerprints: [],
        changedFindings: [{ fingerprint: 'fp-a', addedRows: [{ n: 1 }] }],
      });
      await recordCategoryProgress(started.id, {
        totalFindings: 1, newFindings: 0, newFindingFingerprints: [],
        changedFindings: [{ fingerprint: 'fp-a', addedRows: [{ n: 2 }] }, { fingerprint: 'fp-b', addedRows: [{ n: 3 }] }],
      });

      expect((await getRun(started.id))!.changedFindings).toEqual([
        { fingerprint: 'fp-a', addedRows: [{ n: 1 }, { n: 2 }] },
        { fingerprint: 'fp-b', addedRows: [{ n: 3 }] },
      ]);
    });

    it('lists a row once when the same finding is recorded twice with it, in first-seen order', async () => {
      const started = await startRun({ scheduleId, triggeredBy: 'schedule', categories: [CATEGORY] });

      await recordCategoryProgress(started.id, {
        totalFindings: 1, newFindings: 0, newFindingFingerprints: [],
        changedFindings: [{ fingerprint: 'fp-a', addedRows: [{ name: 'vm-1', retirement: 'TLS 1.0' }, { n: 2 }] }],
      });
      // The same row again with its keys in another order, then a new one, then the first row once more.
      await recordCategoryProgress(started.id, {
        totalFindings: 1, newFindings: 0, newFindingFingerprints: [],
        changedFindings: [{ fingerprint: 'fp-a', addedRows: [{ retirement: 'TLS 1.0', name: 'vm-1' }, { n: 3 }, { n: 2 }] }],
      });

      expect((await getRun(started.id))!.changedFindings).toEqual([
        { fingerprint: 'fp-a', addedRows: [{ name: 'vm-1', retirement: 'TLS 1.0' }, { n: 2 }, { n: 3 }] },
      ]);
    });

    it('keeps what a category recorded when a later one has no changed findings', async () => {
      const started = await startRun({ scheduleId, triggeredBy: 'schedule', categories: [CATEGORY] });
      await recordCategoryProgress(started.id, {
        totalFindings: 1, newFindings: 0, newFindingFingerprints: [],
        changedFindings: [{ fingerprint: 'fp-a', addedRows: [{ n: 1 }] }],
      });

      await recordCategoryProgress(started.id, { totalFindings: 2, newFindings: 0, newFindingFingerprints: [] });

      expect((await getRun(started.id))!.changedFindings).toEqual([{ fingerprint: 'fp-a', addedRows: [{ n: 1 }] }]);
    });
  });
});
