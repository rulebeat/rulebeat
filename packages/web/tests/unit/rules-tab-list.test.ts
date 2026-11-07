/**
 * The Rules tab's list (#402), from the one server function the Scans page calls: which rules a set of URL
 * parameters lists, and each rule's Outcome at the Scope the address names, under the viewer's Access. Driven
 * over the real repositories: rules saved, findings stored through the findings sync, scans through a scan save.
 * Every id is fake.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../helpers/db';
import { EVERYTHING_ACCESS } from '../helpers/access';
import { fakeHierarchy, group, refreshFrom, subscription } from '../helpers/fake-hierarchy';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';
import { buildAccess, parseScope, type Access } from '@/lib/access-model';
import { expandManagementGroups } from '@/lib/management-group-tree';
import { listHierarchyNodes } from '@/lib/db/management-group-hierarchy';
import { createRule, saveRules, setRulesEnabled, setRulesLastRunStatus, updateRule } from '@/lib/rules';
import { saveScanResult } from '@/lib/scan-history';
import { EVERYTHING_COVERED, type CoveredEntry } from '@/lib/run-scope';
import { listRulesTab } from '@/lib/rules-tab-list';
import { EMPTY_RULES_QUERY, type RulesTabQuery } from '@/lib/rules-tab-query';
import { emptySeverityCounts } from '@/lib/severity';
import type { Rule } from '@rulebeat/core';
import type { Finding, ScanSummary } from '@/lib/types';

const TENANT = '00000000-0000-0000-0000-0000000000f0';
const SUB_A = '00000000-0000-0000-0000-00000000000a';
const SUB_B = '00000000-0000-0000-0000-00000000000b';
const SUB_C = '00000000-0000-0000-0000-00000000000c';
const CATEGORY = 'security';

const T1 = '2026-06-01T01:00:00.000Z';
const T2 = '2026-06-02T01:00:00.000Z';

function ruleOf(id: string, over: Partial<Rule> & Record<string, unknown> = {}): Rule {
  return {
    id, name: id, description: 'a test rule', category: CATEGORY, severity: 'medium', enabled: true, type: 'custom',
    scope: { level: 'subscription' }, resourceTypes: [], conditions: [], rawKql: 'resources | project id', ...over,
  } as unknown as Rule;
}

/** A rule's finding in one subscription. */
const findingIn = (ruleId: string, subscriptionId: string, over: Record<string, unknown> = {}): Finding =>
  syntheticFinding(`vm-${ruleId}-${subscriptionId.slice(-1)}`, [{ zone: 'a' }], { ruleId, category: CATEGORY, subscriptionId, resourceGroup: 'rg-one', ...over });

const entries = (...paths: string[]): CoveredEntry[] => paths.map(path => ({ tenantId: TENANT, path }));

interface ScanOptions {
  id: string;
  finishedAt: string;
  subscriptionsScanned: string[];
  coveredScope?: readonly CoveredEntry[];
  ranRuleIds?: string[];
  incompleteRules?: ScanSummary['incompleteRules'];
  findings?: Finding[];
}

/** Stores a finished scan of the test category the way a scan save does, and syncs its findings when it ran rules. */
async function scan(o: ScanOptions): Promise<void> {
  const findings = o.findings ?? [];
  await saveScanResult(CATEGORY, {
    id: o.id, module: CATEGORY, startedAt: o.finishedAt, finishedAt: o.finishedAt, durationMs: 1000,
    subscriptionsScanned: o.subscriptionsScanned, findings, counts: { ...emptySeverityCounts(), high: findings.length },
    totalRules: o.ranRuleIds?.length ?? 0, triggeredBy: 'manual',
    coverage: (o.incompleteRules ?? []).length > 0 ? 'partial' : 'complete', incompleteRules: o.incompleteRules ?? [],
  }, { id: o.id, coveredScope: o.coveredScope ?? EVERYTHING_COVERED, ranRuleIds: o.ranRuleIds });
  if (o.ranRuleIds) {
    const incomplete = new Set((o.incompleteRules ?? []).map(r => r.ruleId));
    await storeScan(findings, {
      scanId: o.id, category: CATEGORY, finishedAt: o.finishedAt, ranRuleIds: o.ranRuleIds.filter(id => !incomplete.has(id)),
    });
  }
}

const list = (query: Partial<RulesTabQuery> = {}, access: Access = EVERYTHING_ACCESS) =>
  listRulesTab({ ...EMPTY_RULES_QUERY, ...query }, access);
const outcomes = async (query: Partial<RulesTabQuery> = {}, access: Access = EVERYTHING_ACCESS) =>
  Object.fromEntries((await list(query, access)).entries.map(e => [e.id, e.outcome]));
const ids = async (query: Partial<RulesTabQuery> = {}, access: Access = EVERYTHING_ACCESS) =>
  (await list(query, access)).entries.map(e => e.id);

beforeEach(async () => {
  await resetDb();
  await refreshFrom(fakeHierarchy([
    group(TENANT, 'Tenant Root Group', null, TENANT),
    group('mg-ab', 'Group of A and B', TENANT, TENANT),
    group('mg-c', 'Group of C', TENANT, TENANT),
    subscription(SUB_A, 'A', 'mg-ab', TENANT),
    subscription(SUB_B, 'B', 'mg-ab', TENANT),
    subscription(SUB_C, 'C', 'mg-c', TENANT),
  ]));
});

describe('a rule\'s Outcome is read at the Scope the address names', () => {
  beforeEach(async () => {
    await saveRules([ruleOf('rule-1')]);
    // One run of Everything covered A and B; the rule found something in A only.
    await scan({
      id: 'scan-1', finishedAt: T1, subscriptionsScanned: [SUB_A, SUB_B], ranRuleIds: ['rule-1'],
      findings: [findingIn('rule-1', SUB_A)],
    });
  });

  it('is Failing with no filter and under the subscription that holds the finding', async () => {
    expect(await outcomes()).toEqual({ 'rule-1': 'failing' });
    expect(await outcomes({ subscriptions: [SUB_A] })).toEqual({ 'rule-1': 'failing' });
  });

  it('is Passing under the subscription that is clean and was covered by a successful run', async () => {
    expect(await outcomes({ subscriptions: [SUB_B] })).toEqual({ 'rule-1': 'passing' });
  });

  it('is Unknown under a subscription no scan covered', async () => {
    expect(await outcomes({ subscriptions: [SUB_C] })).toEqual({ 'rule-1': 'unknown' });
  });

  it('reads a resource group by the subscription it sits in', async () => {
    expect(await outcomes({ subscriptions: [SUB_A], resourceGroups: ['rg-one'] })).toEqual({ 'rule-1': 'failing' });
    expect(await outcomes({ subscriptions: [SUB_A], resourceGroups: ['rg-two'] })).toEqual({ 'rule-1': 'passing' });
    expect(await outcomes({ subscriptions: [SUB_B], resourceGroups: ['rg-one'] })).toEqual({ 'rule-1': 'passing' });
  });

  it('is Failing under a management group that holds the finding and Passing under a clean one that was covered', async () => {
    expect(await outcomes({ managementGroups: ['mg-ab'] })).toEqual({ 'rule-1': 'failing' });
    await scan({ id: 'scan-2', finishedAt: T2, subscriptionsScanned: [SUB_A, SUB_B, SUB_C], ranRuleIds: ['rule-1'], findings: [findingIn('rule-1', SUB_A)] });
    expect(await outcomes({ managementGroups: ['mg-c'] })).toEqual({ 'rule-1': 'passing' });
  });

  it('is Unknown under a management group no scan reached', async () => {
    expect(await outcomes({ managementGroups: ['mg-c'] })).toEqual({ 'rule-1': 'unknown' });
  });

  it('reads a management group by a scan whose covered Scope is at or under it', async () => {
    await scan({
      id: 'scan-2', finishedAt: T2, subscriptionsScanned: [], coveredScope: entries('/providers/Microsoft.Management/managementGroups/mg-c'),
      ranRuleIds: ['rule-1'],
    });
    expect(await outcomes({ managementGroups: ['mg-c'] })).toEqual({ 'rule-1': 'passing' });
  });

  it('reads the Directory by the newest scan whose covered Scope included it', async () => {
    // The first scan covered Everything, which includes the Directory, and the rule has no Directory finding.
    expect(await outcomes({ subscriptions: ['directory'] })).toEqual({ 'rule-1': 'passing' });
    // A newer scan of two subscriptions does not include the Directory, so the first is still the one that covers it.
    await scan({
      id: 'scan-2', finishedAt: T2, subscriptionsScanned: [SUB_A, SUB_B],
      coveredScope: entries(`/subscriptions/${SUB_A}`, `/subscriptions/${SUB_B}`), ranRuleIds: ['rule-1'],
    });
    expect(await outcomes({ subscriptions: ['directory'] })).toEqual({ 'rule-1': 'passing' });
  });
});

describe('the Directory Scope', () => {
  beforeEach(async () => {
    await saveRules([ruleOf('dir-rule', { queryBackend: 'microsoft-graph', graphQuery: { path: 'applications' } })]);
  });

  it('is Failing with a Directory finding, and a subscription Scope does not see it', async () => {
    await scan({
      id: 'scan-1', finishedAt: T1, subscriptionsScanned: [SUB_A], ranRuleIds: ['dir-rule'],
      findings: [syntheticFinding('app-one', [{ zone: 'a' }], { ruleId: 'dir-rule', category: CATEGORY, placement: 'directory' })],
    });
    expect(await outcomes({ subscriptions: ['directory'] })).toEqual({ 'dir-rule': 'failing' });
    expect(await outcomes({ subscriptions: [SUB_A] })).toEqual({ 'dir-rule': 'passing' });
  });

  it('is Passing when a covering scan included the Directory and ran the rule', async () => {
    await scan({ id: 'scan-1', finishedAt: T1, subscriptionsScanned: [SUB_A], ranRuleIds: ['dir-rule'], coveredScope: entries('@directory') });
    expect(await outcomes({ subscriptions: ['directory'] })).toEqual({ 'dir-rule': 'passing' });
  });

  it('is Unknown when the only scans covered subscriptions', async () => {
    await scan({ id: 'scan-1', finishedAt: T1, subscriptionsScanned: [SUB_A], ranRuleIds: ['dir-rule'], coveredScope: entries(`/subscriptions/${SUB_A}`) });
    expect(await outcomes({ subscriptions: ['directory'] })).toEqual({ 'dir-rule': 'unknown' });
    expect(await outcomes({ subscriptions: [SUB_A] })).toEqual({ 'dir-rule': 'passing' });
  });
});

describe('what leaves a rule Unknown or Failing', () => {
  beforeEach(async () => {
    await saveRules([ruleOf('rule-1')]);
  });

  it('leaves a rule Unknown when the covering scan came before the rule existed or was enabled', async () => {
    await scan({ id: 'scan-1', finishedAt: T1, subscriptionsScanned: [SUB_A], ranRuleIds: ['some-other-rule'] });
    expect(await outcomes({ subscriptions: [SUB_A] })).toEqual({ 'rule-1': 'unknown' });
    expect(await outcomes()).toEqual({ 'rule-1': 'unknown' });
  });

  it('leaves a rule Unknown when it was disabled and enabled again after the scan that ran it', async () => {
    await scan({ id: 'scan-1', finishedAt: T1, subscriptionsScanned: [SUB_A], ranRuleIds: ['rule-1'] });
    expect(await outcomes()).toEqual({ 'rule-1': 'passing' });
    await setRulesEnabled(['rule-1'], false);
    await setRulesEnabled(['rule-1'], true);
    expect(await outcomes()).toEqual({ 'rule-1': 'unknown' });
    expect(await outcomes({ subscriptions: [SUB_A] })).toEqual({ 'rule-1': 'unknown' });
  });

  it('leaves a rule Unknown when an edit disables it and a later edit enables it again', async () => {
    await scan({ id: 'scan-1', finishedAt: T1, subscriptionsScanned: [SUB_A], ranRuleIds: ['rule-1'] });
    await updateRule('rule-1', { enabled: false });
    await updateRule('rule-1', { enabled: true });
    expect(await outcomes()).toEqual({ 'rule-1': 'unknown' });
  });

  it('leaves a new rule Unknown against a scan that finished before it was created', async () => {
    await scan({ id: 'scan-1', finishedAt: T1, subscriptionsScanned: [SUB_A], ranRuleIds: ['rule-1', 'rule-new'] });
    await createRule(ruleOf('rule-new'));
    expect((await outcomes())['rule-new']).toBe('unknown');
  });

  it('keeps a rule Passing when it is switched on again while already enabled', async () => {
    await scan({ id: 'scan-1', finishedAt: T1, subscriptionsScanned: [SUB_A], ranRuleIds: ['rule-1'] });
    await setRulesEnabled(['rule-1'], true);
    expect(await outcomes()).toEqual({ 'rule-1': 'passing' });
  });

  it('returns to Passing once a scan after the rule was enabled again ran it', async () => {
    await scan({ id: 'scan-1', finishedAt: T1, subscriptionsScanned: [SUB_A], ranRuleIds: ['rule-1'] });
    await setRulesEnabled(['rule-1'], false);
    await setRulesEnabled(['rule-1'], true);
    await scan({ id: 'scan-2', finishedAt: new Date(Date.now() + 60_000).toISOString(), subscriptionsScanned: [SUB_A], ranRuleIds: ['rule-1'] });
    expect(await outcomes()).toEqual({ 'rule-1': 'passing' });
  });

  it('reads a scan saved before scans recorded their rules by the rule\'s own last run', async () => {
    await scan({ id: 'scan-1', finishedAt: T1, subscriptionsScanned: [SUB_A] });
    expect(await outcomes()).toEqual({ 'rule-1': 'unknown' });
    await setRulesLastRunStatus(['rule-1'], 'success', T1);
    expect(await outcomes()).toEqual({ 'rule-1': 'passing' });
  });

  it('is Unknown when the newest covering scan capped the rule with no finding to show for it', async () => {
    await scan({
      id: 'scan-1', finishedAt: T1, subscriptionsScanned: [SUB_A], ranRuleIds: ['rule-1'],
      incompleteRules: [{ ruleId: 'rule-1', ruleName: 'rule-1', status: 'capped' }],
    });
    expect(await outcomes()).toEqual({ 'rule-1': 'unknown' });
  });

  it('is Failing when the newest covering scan capped or failed the rule but a finding is open', async () => {
    await scan({ id: 'scan-1', finishedAt: T1, subscriptionsScanned: [SUB_A], ranRuleIds: ['rule-1'], findings: [findingIn('rule-1', SUB_A)] });
    await scan({
      id: 'scan-2', finishedAt: T2, subscriptionsScanned: [SUB_A], ranRuleIds: ['rule-1'],
      incompleteRules: [{ ruleId: 'rule-1', ruleName: 'rule-1', status: 'capped' }],
    });
    expect(await outcomes()).toEqual({ 'rule-1': 'failing' });
    expect(await outcomes({ subscriptions: [SUB_A] })).toEqual({ 'rule-1': 'failing' });
  });

  it('uses the newest covering scan, not an older clean one', async () => {
    await scan({ id: 'scan-1', finishedAt: T1, subscriptionsScanned: [SUB_A], ranRuleIds: ['rule-1'] });
    await scan({
      id: 'scan-2', finishedAt: T2, subscriptionsScanned: [SUB_A], ranRuleIds: ['rule-1'],
      incompleteRules: [{ ruleId: 'rule-1', ruleName: 'rule-1', status: 'failed' }],
    });
    expect(await outcomes({ subscriptions: [SUB_A] })).toEqual({ 'rule-1': 'unknown' });
  });

  it('skips a newer scan that did not cover the Scope', async () => {
    await scan({ id: 'scan-1', finishedAt: T1, subscriptionsScanned: [SUB_A], ranRuleIds: ['rule-1'] });
    await scan({ id: 'scan-2', finishedAt: T2, subscriptionsScanned: [SUB_B], ranRuleIds: [] });
    expect(await outcomes({ subscriptions: [SUB_A] })).toEqual({ 'rule-1': 'passing' });
  });

  it('does not count a suppressed finding as open', async () => {
    const finding = findingIn('rule-1', SUB_A);
    await scan({ id: 'scan-1', finishedAt: T1, subscriptionsScanned: [SUB_A], ranRuleIds: ['rule-1'], findings: [finding] });
    const { addSuppression } = await import('@/lib/suppressions');
    await addSuppression({ id: 'sup-1', fingerprint: finding.fingerprint, resourceId: finding.resourceId, reason: 'accepted', suppressedAt: T1 });
    expect(await outcomes()).toEqual({ 'rule-1': 'passing' });
  });
});

describe('kinds and enabled', () => {
  beforeEach(async () => {
    await saveRules([
      ruleOf('problem-failing'), ruleOf('problem-passing'), ruleOf('problem-unknown'),
      ruleOf('advisory-rule', { kind: 'advisory' }),
      ruleOf('activity-rule', { queryBackend: 'log-analytics', logsQuery: { kql: 'SigninLogs', timeWindowDays: 7 } }),
      ruleOf('activity-unknown', { queryBackend: 'log-analytics', logsQuery: { kql: 'SigninLogs', timeWindowDays: 7 } }),
      ruleOf('disabled-rule', { enabled: false }),
    ]);
    await scan({
      id: 'scan-1', finishedAt: T1, subscriptionsScanned: [SUB_A],
      ranRuleIds: ['problem-failing', 'problem-passing', 'advisory-rule', 'activity-rule', 'disabled-rule'],
      findings: [findingIn('problem-failing', SUB_A), findingIn('advisory-rule', SUB_A, { kind: 'advisory' })],
    });
  });

  it('gives every enabled rule an Outcome, an Activity rule only checked or unknown, and a disabled rule none', async () => {
    expect(await outcomes()).toEqual({
      'problem-failing': 'failing', 'problem-passing': 'passing', 'problem-unknown': 'unknown', 'advisory-rule': 'failing',
      'activity-rule': 'checked', 'activity-unknown': 'unknown', 'disabled-rule': null,
    });
  });

  it('lists the rules of one kind: problem, advisory or activity', async () => {
    expect(await ids({ kind: 'problem' })).toEqual(['problem-failing', 'problem-passing', 'problem-unknown', 'disabled-rule']);
    expect(await ids({ kind: 'advisory' })).toEqual(['advisory-rule']);
    expect(await ids({ kind: 'activity' })).toEqual(['activity-rule', 'activity-unknown']);
  });

  it('lists the rules with one Outcome', async () => {
    expect(await ids({ outcome: 'failing' })).toEqual(['problem-failing', 'advisory-rule']);
    expect(await ids({ outcome: 'passing' })).toEqual(['problem-passing']);
    expect(await ids({ outcome: 'unknown' })).toEqual(['problem-unknown', 'activity-unknown']);
  });

  it('reads checked as passing or failing, for every kind', async () => {
    expect(await ids({ outcome: 'checked' })).toEqual(['problem-failing', 'problem-passing', 'advisory-rule', 'activity-rule']);
    expect(await ids({ outcome: 'checked', kind: 'activity' })).toEqual(['activity-rule']);
    expect(await ids({ outcome: 'checked', kind: 'advisory' })).toEqual(['advisory-rule']);
    expect(await ids({ outcome: 'checked', kind: 'problem' })).toEqual(['problem-failing', 'problem-passing']);
  });

  it('never reads an Activity rule as passing or failing', async () => {
    expect(await ids({ outcome: 'passing', kind: 'activity' })).toEqual([]);
    expect(await ids({ outcome: 'failing', kind: 'activity' })).toEqual([]);
  });

  it('lists the enabled rules, the disabled rules, or all of them, and all by default', async () => {
    expect(await ids({ rules: 'all' })).toHaveLength(7);
    expect(await ids()).toHaveLength(7);
    expect(await ids({ rules: 'enabled' })).not.toContain('disabled-rule');
    expect(await ids({ rules: 'enabled' })).toHaveLength(6);
    expect(await ids({ rules: 'disabled' })).toEqual(['disabled-rule']);
  });

  it('lists nothing, without an error, for an Outcome among the disabled rules', async () => {
    for (const outcome of ['passing', 'failing', 'unknown', 'checked'] as const) {
      expect(await ids({ rules: 'disabled', outcome })).toEqual([]);
    }
  });

  it('counts the resources affected inside the Scope', async () => {
    const forA = (await list({ subscriptions: [SUB_A] })).entries.find(e => e.id === 'problem-failing');
    const forB = (await list({ subscriptions: [SUB_B] })).entries.find(e => e.id === 'problem-failing');
    expect(forA?.findingCount).toBe(1);
    expect(forB?.findingCount).toBe(0);
  });
});

describe('the other filters', () => {
  beforeEach(async () => {
    await saveRules([
      ruleOf('core-high', { category: 'security', severity: 'high', type: 'builtin', pack: 'rulebeat-core', tags: ['prod'] }),
      ruleOf('aprl-low', { category: 'network', severity: 'low', type: 'builtin', pack: 'aprl-v2', tags: ['prod', 'pci'] }),
      ruleOf('custom-high', { category: 'network', severity: 'high', tags: ['dev'] }),
    ]);
  });

  it('filters by category, source, tags and severity, any value matching', async () => {
    expect(await ids({ categories: ['network'] })).toEqual(['aprl-low', 'custom-high']);
    expect(await ids({ sources: ['aprl-v2'] })).toEqual(['aprl-low']);
    expect(await ids({ sources: ['custom'] })).toEqual(['custom-high']);
    expect(await ids({ sources: ['rulebeat-core', 'custom'] })).toEqual(['core-high', 'custom-high']);
    expect(await ids({ tags: ['pci', 'dev'] })).toEqual(['aprl-low', 'custom-high']);
    expect(await ids({ severities: ['high'] })).toEqual(['core-high', 'custom-high']);
  });

  it('combines the filters, each narrowing the others', async () => {
    expect(await ids({ categories: ['network'], severities: ['high'], tags: ['dev'] })).toEqual(['custom-high']);
    expect(await ids({ categories: ['security'], tags: ['dev'] })).toEqual([]);
  });
});

describe('under a reader below Everything', () => {
  const grantTo = (...paths: string[]): Promise<Access> => listHierarchyNodes().then(nodes => {
    const grants = paths.map(path => ({ tenantId: TENANT, scope: parseScope(path)!, role: 'viewer' as const }));
    return buildAccess(grants, 'manual', expandManagementGroups(grants, nodes));
  });

  beforeEach(async () => {
    await saveRules([ruleOf('rule-1')]);
    // The rule is open in B only, and one scan covered A and B.
    await scan({
      id: 'scan-1', finishedAt: T1, subscriptionsScanned: [SUB_A, SUB_B], ranRuleIds: ['rule-1'],
      findings: [findingIn('rule-1', SUB_B)],
    });
  });

  it('reads Outcome over their own Scopes when no Scope is chosen, never counting a finding they cannot see', async () => {
    const viewerOnA = await grantTo(`/subscriptions/${SUB_A}`);
    const viewerOnB = await grantTo(`/subscriptions/${SUB_B}`);
    expect(await outcomes({}, viewerOnA)).toEqual({ 'rule-1': 'passing' });
    expect(await outcomes({}, viewerOnB)).toEqual({ 'rule-1': 'failing' });
    expect((await list({}, viewerOnA)).entries[0]!.findingCount).toBe(0);
  });

  it('reads a Scope they do not hold as Unknown, and shows nothing of what is there', async () => {
    const viewerOnA = await grantTo(`/subscriptions/${SUB_A}`);
    expect(await outcomes({ subscriptions: [SUB_B] }, viewerOnA)).toEqual({ 'rule-1': 'unknown' });
    expect(await outcomes({ managementGroups: ['mg-c'] }, viewerOnA)).toEqual({ 'rule-1': 'unknown' });
  });

  it('reads a Scope they do not hold as Unknown even when a scan\'s covered Scope names it', async () => {
    await scan({
      id: 'scan-2', finishedAt: T2, subscriptionsScanned: [], coveredScope: entries('/providers/Microsoft.Management/managementGroups/mg-c'),
      ranRuleIds: ['rule-1'],
    });
    const viewerOnA = await grantTo(`/subscriptions/${SUB_A}`);
    expect(await outcomes({ managementGroups: ['mg-c'] })).toEqual({ 'rule-1': 'passing' });
    expect(await outcomes({ managementGroups: ['mg-c'] }, viewerOnA)).toEqual({ 'rule-1': 'unknown' });
    // The scan of Everything covers the Directory, which this person does not hold.
    expect(await outcomes({ subscriptions: ['directory'] })).toEqual({ 'rule-1': 'passing' });
    expect(await outcomes({ subscriptions: ['directory'] }, viewerOnA)).toEqual({ 'rule-1': 'unknown' });
  });

  it('covers a Scope only by the subscriptions they hold in a scan', async () => {
    const viewerOnC = await grantTo(`/subscriptions/${SUB_C}`);
    expect(await outcomes({}, viewerOnC)).toEqual({ 'rule-1': 'unknown' });
  });

  it('reads their management group over the subscriptions under it', async () => {
    const viewerOnGroup = await grantTo('/providers/Microsoft.Management/managementGroups/mg-ab');
    expect(await outcomes({}, viewerOnGroup)).toEqual({ 'rule-1': 'failing' });
    expect(await outcomes({ subscriptions: [SUB_A] }, viewerOnGroup)).toEqual({ 'rule-1': 'passing' });
  });

  it('reads Unknown for a person who holds no Scope', async () => {
    expect(await outcomes({}, buildAccess([], 'manual'))).toEqual({ 'rule-1': 'unknown' });
  });
});
