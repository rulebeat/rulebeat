/**
 * Issue #176, end to end: a Problem rule and an Advisory rule scan through runCategoryScan(), then
 * every read path is asked what it counts. Posture, the tiles, the severity breakdown, top rules,
 * top resources, recent findings and the stat cards count Problem findings only; the Advisories
 * read model lists the Advisory ones; a kind switch moves the same findings across without
 * touching their age or suppression; and a failed or capped Advisory rule leaves its findings open.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeFingerprint } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { rules as rulesTable } from '@/lib/db/tables';
import { getCategory } from '@/lib/db/categories';
import { createUser } from '@/lib/db/users';
import { runCategoryScan } from '@/lib/scan-runner';
import { listFindings } from '@/lib/db/findings';
import { getSnapshots } from '@/lib/db/snapshots';
import { computeWidgetSummary } from '@/lib/dashboard-data';
import { buildExplorerData } from '@/lib/explorer-data';
import { summarizeFindings, countFindingsByRule } from '@/lib/explorer-filters';
import { addSuppression, loadSuppressions, isActiveSuppression } from '@/lib/suppressions';
import { loadRules, updateRule } from '@/lib/rules';
import { ADVISORY_KINDS, RESULTS_KINDS } from '@/lib/finding-kinds';
import type { RuleKind } from '@rulebeat/core';
import { resetDb, clearRules } from '../helpers/db';
import { argRow, fakeTenantContext } from '../helpers/fake-azure';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
const topRules = await import('@/app/api/widgets/top-rules/route');
const topResources = await import('@/app/api/widgets/top-resources/route');
const recentFindings = await import('@/app/api/widgets/findings/route');

const PROBLEM = 'adv-e2e-problem';
const ADVISORY = 'adv-e2e-advisory';
const P_MARK = '// marker-problem';
const A_MARK = '// marker-advisory';
const WINDOW = { from: '2000-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' };

const problemRows = [argRow({ name: 'vm-p1' }), argRow({ name: 'vm-p2' })];
const advisoryRows = [argRow({ name: 'vm-a1' }), argRow({ name: 'vm-a2' }), argRow({ name: 'vm-a3' })];

async function insertRule(id: string, marker: string, kind: 'state' | 'advisory', severity = 'high'): Promise<void> {
  await execRun(db.insert(rulesTable).values({
    id, name: id, description: 'test rule', category: 'security', severity, enabled: true,
    scope: JSON.stringify({ level: 'subscription' }), resourceTypes: JSON.stringify([]),
    conditions: JSON.stringify([]),
    rawKql: `resources | where type == "microsoft.compute/virtualmachines" ${marker}`,
    type: 'custom', kind,
  }));
}

function ctxWith(behavior: { problem?: 'ok' | 'fail'; advisory?: 'ok' | 'fail' }) {
  return fakeTenantContext({
    rows: (kql) => {
      const isAdvisory = kql.includes(A_MARK);
      const mode = (isAdvisory ? behavior.advisory : behavior.problem) ?? 'ok';
      if (mode === 'fail') throw new Error('429 Too Many Requests');
      return isAdvisory ? advisoryRows : problemRows;
    },
  });
}

async function scan(behavior: Parameters<typeof ctxWith>[0] = {}) {
  const category = (await getCategory('security'))!;
  return runCategoryScan(category, { ctx: ctxWith(behavior), ruleIds: [PROBLEM, ADVISORY] });
}

async function asViewer(): Promise<void> {
  const result = await createUser({ email: 'viewer@example.com', role: 'viewer' });
  if ('error' in result) throw new Error(result.error);
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
}

describe('an Advisory rule and a Problem rule through a scan (#176)', () => {
  beforeEach(async () => {
    await resetDb();
    await clearRules();
    mockAuth.mockReset();
    await asViewer();
    await insertRule(PROBLEM, P_MARK, 'state');
    await insertRule(ADVISORY, A_MARK, 'advisory');
  });

  it('stores each finding under its rule\'s kind', async () => {
    await scan();
    const all = await listFindings();
    expect(all.filter(f => f.ruleId === PROBLEM).map(f => f.kind)).toEqual(['state', 'state']);
    expect(all.filter(f => f.ruleId === ADVISORY).map(f => f.kind)).toEqual(['advisory', 'advisory', 'advisory']);
  });

  it('counts only Problem findings in posture, the severity breakdown and the daily snapshot', async () => {
    await scan();
    const summary = await computeWidgetSummary({ categories: ['security'], dateWindow: { mode: 'relative', days: 7 } }, 30);
    expect(summary.current.activeFindings).toBe(2);
    expect(summary.current.severityCounts.high).toBe(2);
    const snapshot = (await getSnapshots({ categories: ['security'] })).at(-1);
    expect(snapshot?.activeFindings).toBe(2);
  });

  it('counts only the Activity rule as an activity rule, in the summary and the daily snapshot', async () => {
    await execRun(db.insert(rulesTable).values({
      id: 'adv-e2e-activity', name: 'adv-e2e-activity', description: 'test rule', category: 'security', severity: 'high',
      enabled: true, scope: JSON.stringify({ level: 'subscription' }), resourceTypes: JSON.stringify([]),
      conditions: JSON.stringify([]), rawKql: 'resources // marker-activity', type: 'custom', kind: 'activity',
    }));
    await scan();
    const summary = await computeWidgetSummary({ categories: ['security'], dateWindow: { mode: 'relative', days: 7 } }, 30);
    expect(summary.current.totalRules).toBe(1);
    expect(summary.current.activityRuleCount).toBe(1);
    const scoped = await computeWidgetSummary({ ruleIds: [PROBLEM, ADVISORY, 'adv-e2e-activity'], dateWindow: { mode: 'relative', days: 7 } }, 30);
    expect(scoped.current.activityRuleCount).toBe(1);
    const snapshot = (await getSnapshots({ categories: ['security'] })).at(-1);
    expect(snapshot?.totalRules).toBe(1);
    expect(snapshot?.activityRuleCount).toBe(1);
  });

  it('counts only Problem findings in top rules, top resources and recent findings', async () => {
    await scan();
    const rulesJson = await (await topRules.GET(new Request('http://localhost/api/widgets/top-rules'))).json();
    expect(rulesJson.map((r: { ruleId: string; count: number }) => [r.ruleId, r.count])).toEqual([[PROBLEM, 2]]);
    const resources = await (await topResources.GET(new Request('http://localhost/api/widgets/top-resources'))).json();
    expect(JSON.stringify(resources)).not.toContain('vm-a');
    expect(JSON.stringify(resources)).toContain('vm-p');
    const recent = await (await recentFindings.GET(new Request('http://localhost/api/widgets/findings'))).json();
    expect(JSON.stringify(recent)).not.toContain('vm-a');
    expect(JSON.stringify(recent)).toContain('vm-p');
  });

  it('keeps Advisory findings out of the Results listing, and the tiles add up to Open', async () => {
    await scan();
    const results = await buildExplorerData();
    expect(results.findings.map(f => f.ruleId)).toEqual([PROBLEM, PROBLEM]);
    const stats = summarizeFindings(results.findings, WINDOW.from, WINDOW.to);
    const bySeverity = Object.values(stats.counts).reduce((a, b) => a + b, 0);
    expect(stats.total).toBe(2);
    expect(bySeverity).toBe(stats.total);
    expect([...countFindingsByRule(results.findings, WINDOW.from, WINDOW.to).keys()]).toEqual([PROBLEM]);
  });

  it('lists Advisory findings, with their rule name, in the Advisories read model', async () => {
    await scan();
    const advisories = await buildExplorerData({ kinds: ['advisory'] });
    expect(advisories.findings.map(f => f.resourceName).sort()).toEqual(['vm-a1', 'vm-a2', 'vm-a3']);
    expect(advisories.findings.every(f => f.policyName === ADVISORY && f.kind === 'advisory')).toBe(true);
    const stats = summarizeFindings(advisories.findings, WINDOW.from, WINDOW.to, ['advisory']);
    expect(stats.total).toBe(3);
    expect(countFindingsByRule(advisories.findings, WINDOW.from, WINDOW.to, ['advisory']).get(ADVISORY)?.open).toBe(3);
  });

  it('moves the same findings across a kind switch and rescan, keeping their age and suppression', async () => {
    await scan();
    const before = (await listFindings()).find(f => f.ruleId === ADVISORY && f.resourceName === 'vm-a1')!;
    await addSuppression({
      id: 'sup-1', fingerprint: before.fingerprint, resourceId: before.resourceId,
      reason: 'accepted', suppressedAt: new Date().toISOString(),
    });

    await updateRule(ADVISORY, { kind: 'state' });
    await scan();

    const after = (await listFindings()).find(f => f.fingerprint === before.fingerprint)!;
    expect(after.kind).toBe('state');
    expect(after.firstSeenAt).toBe(before.firstSeenAt);
    expect(after.status).toBe('active');
    expect((await loadSuppressions()).filter(isActiveSuppression).map(s => s.fingerprint)).toContain(before.fingerprint);
    expect((await buildExplorerData()).findings.filter(f => f.ruleId === ADVISORY)).toHaveLength(3);
    expect((await buildExplorerData({ kinds: ['advisory'] })).findings).toHaveLength(0);

    await updateRule(ADVISORY, { kind: 'advisory' });
    await scan();
    expect((await buildExplorerData({ kinds: ['advisory'] })).findings).toHaveLength(3);
    expect((await listFindings()).find(f => f.fingerprint === before.fingerprint)?.firstSeenAt).toBe(before.firstSeenAt);
  });

  it('leaves the rule, its findings and how they display unchanged by a kind switch, apart from the tab they list under', async () => {
    const ruleOf = async () => {
      const { kind, lastRunAt: _at, lastRunStatus: _status, ...rest } = (await loadRules()).find(r => r.id === ADVISORY)!;
      return { kind, rest };
    };
    const rowsOf = async (kinds: readonly RuleKind[]) => (await buildExplorerData({ kinds })).findings
      .filter(f => f.ruleId === ADVISORY)
      .map(({ fingerprint, ruleId, policyName, severity, resourceId, resourceName, title, description, recommendation, rows, firstSeenAt, status }) =>
        ({ fingerprint, ruleId, policyName, severity, resourceId, resourceName, title, description, recommendation, rows, firstSeenAt, status }))
      .sort((a, b) => (a.resourceId ?? '').localeCompare(b.resourceId ?? ''));

    await scan();
    const ruleBefore = await ruleOf();
    const rowsBefore = await rowsOf(ADVISORY_KINDS);
    expect(rowsBefore).toHaveLength(3);

    await updateRule(ADVISORY, { kind: 'state' });
    await scan();
    const ruleAfter = await ruleOf();
    expect([ruleBefore.kind, ruleAfter.kind]).toEqual(['advisory', 'state']);
    expect(ruleAfter.rest).toEqual(ruleBefore.rest);
    expect(await rowsOf(RESULTS_KINDS)).toEqual(rowsBefore);
    expect(await rowsOf(ADVISORY_KINDS)).toEqual([]);
    for (const key of ['deadlineField', 'groupField']) expect(ruleAfter.rest).not.toHaveProperty(key);
  });

  it('resolves an Advisory finding that stops appearing when the rule ran successfully', async () => {
    await scan();
    const category = (await getCategory('security'))!;
    await runCategoryScan(category, {
      ctx: fakeTenantContext({ rows: kql => (kql.includes(A_MARK) ? [advisoryRows[0]] : problemRows) }),
      ruleIds: [PROBLEM, ADVISORY],
    });
    const advisory = (await listFindings()).filter(f => f.ruleId === ADVISORY);
    expect(advisory.filter(f => f.status === 'active')).toHaveLength(1);
    expect(advisory.filter(f => f.status === 'fixed')).toHaveLength(2);
  });

  it('leaves prior Advisories open and marks coverage partial when the Advisory rule fails', async () => {
    await scan();
    const outcome = await scan({ advisory: 'fail' });
    expect(outcome.summary.coverage).toBe('partial');
    expect(outcome.summary.incompleteRules.map(r => r.ruleId)).toEqual([ADVISORY]);
    expect(outcome.summary.totalRules).toBe(2);
    const advisory = (await listFindings()).filter(f => f.ruleId === ADVISORY);
    expect(advisory).toHaveLength(3);
    expect(advisory.every(f => f.status === 'active')).toBe(true);
  });

  it('leaves prior Advisories open when the Advisory rule is capped by a top-level take', async () => {
    await scan();
    await updateRule(ADVISORY, { rawKql: `resources | where type == "microsoft.compute/virtualmachines" | take 1 ${A_MARK}` });
    const outcome = await runCategoryScan((await getCategory('security'))!, {
      ctx: fakeTenantContext({ rows: kql => (kql.includes(A_MARK) ? [advisoryRows[0]] : problemRows) }),
      ruleIds: [PROBLEM, ADVISORY],
    });
    expect(outcome.summary.coverage).toBe('partial');
    expect(outcome.summary.incompleteRules).toEqual([expect.objectContaining({ ruleId: ADVISORY, status: 'capped' })]);
    const advisory = (await listFindings()).filter(f => f.ruleId === ADVISORY);
    expect(advisory.every(f => f.status === 'active')).toBe(true);
  });

  it('computes the fingerprint exactly as a Problem finding does', async () => {
    await scan();
    const f = (await listFindings()).find(x => x.ruleId === ADVISORY && x.resourceName === 'vm-a1')!;
    expect(f.fingerprint).toBe(computeFingerprint(ADVISORY, f.resourceId!));
  });
});
