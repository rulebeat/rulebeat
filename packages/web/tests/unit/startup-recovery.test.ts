/**
 * Spec 025 — two-pass startup crash recovery: interrupted `schedule_runs` rows left `status:
 * 'running'` by a crashed process (pass 1, recoverInterruptedRuns), and the durable notification
 * outbox for a run whose findings were persisted but never confirmed dispatched (pass 2,
 * recoverPendingNotifications). Also covers the live post-scan path in run-executor.ts that writes
 * the same notifyStatus states recovery reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenCredential } from '@azure/identity';
import type { TenantContext } from '@rulebeat/core';
import { computeFingerprint } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { rules as rulesTable } from '@/lib/db/schema';
import { syncScanFindings, deleteFindingsForRule } from '@/lib/db/findings';
import { startRun, finishRun, getRun } from '@/lib/schedule-runs';
import { recoverInterruptedRuns, recoverPendingNotifications } from '@/lib/startup-recovery';
import { executeTarget } from '@/lib/run-executor';
import { createChannel, deleteChannel } from '@/lib/db/notification-channels';
import { setLinksForSchedule, deleteLinksForSchedule } from '@/lib/db/schedule-notification-channels';
import { setDnsLookupForTests, resetDnsLookupForTests } from '@/lib/ssrf-guard';
import { resetDb, clearRules } from '../helpers/db';
import { argRow, TEST_SUB_A } from '../helpers/fake-azure';
import type { Finding } from '@/lib/types';

const RULE_A = 'test-rule-a';
const CATEGORY = 'security';
const MARKER_OK = '// marker-ok';
const MARKER_EMPTY = '// marker-empty';

function finding(resourceSuffix: string, overrides: Partial<Finding> & { ruleId?: string } = {}): Finding {
  const ruleId = overrides.ruleId ?? RULE_A;
  const resourceId = overrides.resourceId
    ?? `/subscriptions/sub-1/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/${resourceSuffix}`;
  return {
    module: CATEGORY,
    ruleId,
    fingerprint: computeFingerprint(ruleId, resourceId),
    severity: 'medium',
    category: CATEGORY,
    resourceId,
    resourceType: 'microsoft.compute/virtualmachines',
    resourceName: resourceSuffix,
    subscriptionId: 'sub-1',
    title: 'test finding',
    description: 'test',
    evidence: {},
    recommendation: 'fix it',
    remediationSteps: [],
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

function insertRule(id: string, marker: string): void {
  db.insert(rulesTable).values({
    id,
    name: id,
    description: 'test rule',
    category: CATEGORY,
    severity: 'medium',
    enabled: true,
    scope: JSON.stringify({ level: 'subscription' }),
    resourceTypes: JSON.stringify([]),
    conditions: JSON.stringify([]),
    rawKql: `resources | where type == "microsoft.compute/virtualmachines" ${marker}`,
    type: 'custom',
  }).run();
}

type QueryBehavior = Record<string, { rows?: Record<string, unknown>[] }>;

function makeCtx(behavior: QueryBehavior): TenantContext {
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
      const marker = Object.keys(behavior).find(m => kql.includes(m));
      if (!marker) throw new Error(`test ctx: no behavior registered for query: ${kql}`);
      return (behavior[marker]!.rows ?? []) as TRow[];
    },
  };
}

function fakeResponse(status: number, body = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    type: 'basic',
    text: async () => body,
  } as Response;
}

beforeEach(async () => {
  await resetDb();
  await clearRules();
});

describe('recoverInterruptedRuns (pass 1)', () => {
  it('flips a stale "running" row to "error" with finishedAt and a client-safe recovery message', async () => {
    const run = await startRun({ scheduleId: '', triggeredBy: 'manual', categories: [CATEGORY] });
    expect(run.status).toBe('running');

    const recovered = await recoverInterruptedRuns();
    expect(recovered).toBe(1);

    const after = (await getRun(run.id))!;
    expect(after.status).toBe('error');
    expect(after.finishedAt).not.toBeNull();
    expect(after.error).toBe('Run did not complete. The server restarted or crashed while this scan was in progress.');
    expect(after.error).not.toMatch(/—/); // no em dash in product-facing copy
  });
});

describe('recoverPendingNotifications (pass 2)', () => {
  let scheduleId: string;
  let channelId: string;

  beforeEach(async () => {
    scheduleId = `sched-${crypto.randomUUID()}`;
    channelId = (await createChannel({ name: 'Test channel', type: 'webhook', url: 'https://example.test/hook' })).id;
    await setLinksForSchedule(scheduleId, [{ channelId, minSeverity: 'low', categoryIds: null, subscriptionIds: null }]);
    setDnsLookupForTests(async () => [{ address: '93.184.216.34' }]);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    resetDnsLookupForTests();
    await deleteLinksForSchedule(scheduleId);
    await deleteChannel(channelId);
  });

  it('dispatches a pending run whose fingerprints resolve to real findings, then marks it sent', async () => {
    const f = finding('vm-1');
    await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: new Date().toISOString() });

    const run = await startRun({ scheduleId, triggeredBy: 'schedule', categories: [CATEGORY] });
    await finishRun(run.id, {
      status: 'success', totalFindings: 1, newFindings: 1,
      newFindingFingerprints: [f.fingerprint], durationMs: 100, notifyStatus: 'pending',
    });

    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, 'ok'));
    vi.stubGlobal('fetch', fetchMock);

    const recovered = await recoverPendingNotifications();

    expect(recovered).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await getRun(run.id))!.notifyStatus).toBe('sent');
  });

  it('leaves an already-sent run untouched — no re-dispatch', async () => {
    const run = await startRun({ scheduleId, triggeredBy: 'schedule', categories: [CATEGORY] });
    await finishRun(run.id, {
      status: 'success', totalFindings: 0, newFindings: 0,
      newFindingFingerprints: [], durationMs: 100, notifyStatus: 'sent',
    });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const recovered = await recoverPendingNotifications();

    expect(recovered).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await getRun(run.id))!.notifyStatus).toBe('sent');
  });

  it('marks a pending run sent without dispatching when its fingerprints belong to a hard-deleted rule', async () => {
    const f = finding('vm-2');
    await syncScanFindings({ scanId: 's2', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: new Date().toISOString() });
    await deleteFindingsForRule(RULE_A);

    const run = await startRun({ scheduleId, triggeredBy: 'schedule', categories: [CATEGORY] });
    await finishRun(run.id, {
      status: 'success', totalFindings: 1, newFindings: 1,
      newFindingFingerprints: [f.fingerprint], durationMs: 100, notifyStatus: 'pending',
    });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const recovered = await recoverPendingNotifications();

    expect(recovered).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await getRun(run.id))!.notifyStatus).toBe('sent');
  });
});

describe('await executeTarget() live path (notifyStatus persisted before + after dispatch)', () => {
  let scheduleId: string;
  let channelId: string;

  beforeEach(async () => {
    scheduleId = `sched-${crypto.randomUUID()}`;
    channelId = (await createChannel({ name: 'Test channel', type: 'webhook', url: 'https://example.test/hook' })).id;
    await setLinksForSchedule(scheduleId, [{ channelId, minSeverity: 'low', categoryIds: null, subscriptionIds: null }]);
    setDnsLookupForTests(async () => [{ address: '93.184.216.34' }]);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    resetDnsLookupForTests();
    await deleteLinksForSchedule(scheduleId);
    await deleteChannel(channelId);
  });

  it('persists notifyStatus: pending durably before the webhook resolves, then sent once it does', async () => {
    insertRule(RULE_A, MARKER_OK);

    let resolveFetch: (value: Response) => void = () => {};
    const fetchPromise = new Promise<Response>(resolve => { resolveFetch = resolve; });
    const fetchMock = vi.fn().mockReturnValue(fetchPromise);
    vi.stubGlobal('fetch', fetchMock);

    const run = await executeTarget(
      { targetType: 'categories', targetValues: [CATEGORY] },
      { triggeredBy: 'schedule', scheduleId, ctx: makeCtx({ [MARKER_OK]: { rows: [argRow({ name: 'vm-1' })] } }) },
    );

    // await executeTarget() fires dispatch without awaiting it — give the microtask queue a chance to
    // reach the (deliberately unresolved) fetch call before asserting the durable outbox state.
    await vi.waitFor(async () => expect(fetchMock).toHaveBeenCalled());
    expect((await getRun(run.id))!.notifyStatus).toBe('pending');

    resolveFetch(fakeResponse(200, 'ok'));
    await vi.waitFor(async () => expect((await getRun(run.id))!.notifyStatus).toBe('sent'));
  });
});

describe('notifyStatus stays "none" when there is nothing to notify', () => {
  it('a manual run with new findings never sets notifyStatus, even though findings are new', async () => {
    insertRule(RULE_A, MARKER_OK);

    const run = await executeTarget(
      { targetType: 'categories', targetValues: [CATEGORY] },
      { triggeredBy: 'manual', ctx: makeCtx({ [MARKER_OK]: { rows: [argRow({ name: 'vm-1' })] } }) },
    );

    expect(run.newFindings).toBeGreaterThan(0);
    expect(run.notifyStatus).toBe('none');
  });

  it('a schedule run with zero new findings leaves notifyStatus none, and recovery finds nothing pending', async () => {
    insertRule(RULE_A, MARKER_EMPTY);
    const scheduleId = `sched-${crypto.randomUUID()}`;

    const run = await executeTarget(
      { targetType: 'categories', targetValues: [CATEGORY] },
      { triggeredBy: 'schedule', scheduleId, ctx: makeCtx({ [MARKER_EMPTY]: { rows: [] } }) },
    );

    expect(run.newFindings).toBe(0);
    expect(run.notifyStatus).toBe('none');

    const recovered = await recoverPendingNotifications();
    expect(recovered).toBe(0);
  });
});
