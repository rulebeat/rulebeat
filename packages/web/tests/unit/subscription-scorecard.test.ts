/**
 * The Subscription scorecard's rows (posture formula v3, at the subscription level), read through
 * computeWidgetSummary over a real database: every known subscription gets a row, graded by the rules
 * whose scope covers it and by the findings placed inside it; the Directory has a row of its own for
 * whoever holds it; a part-held subscription is counted over the held part; and the footer counts the
 * findings no row can hold, which is exactly the Scans list its link opens.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { rules as rulesTable } from '@/lib/db/tables';
import { addSuppression } from '@/lib/suppressions';
import { replaceHierarchy } from '@/lib/db/management-group-hierarchy';
import { queryView } from '@/lib/db/finding-views';
import { computeWidgetSummary } from '@/lib/dashboard-data';
import { viewFromSearchParams } from '@/lib/finding-view';
import { buildAccess, type Access, type ScopeGrant } from '@/lib/access-model';
import { buildScansHref } from '@/lib/scans-link';
import { mergeWidgetFilters, type WidgetFilters } from '@/lib/dashboard-filters';
import { NO_ACCESS_HEADING, WIDGET_LIMITS } from '@/lib/widget-limits';
import type { HierarchyNode } from '@/lib/management-group-tree';
import type { RuleScope } from '@/lib/types';
import { clearRules, resetDb } from '../helpers/db';
import { EVERYTHING_ACCESS } from '../helpers/access';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';

const T = 'tenant-1';
const SUB_A = '00000000-0000-0000-0000-00000000000a';
const SUB_B = '00000000-0000-0000-0000-00000000000b';
const SUB_C = '00000000-0000-0000-0000-00000000000c';
const SUB_D = '00000000-0000-0000-0000-00000000000d';
const window = { mode: 'relative', days: 7 } as const;
const NOW = new Date().toISOString();

async function insertRule(
  id: string, over: { scope?: RuleScope; lastRunStatus?: string | null; queryBackend?: string; category?: string; severity?: string; enabled?: boolean; tags?: string[] } = {},
): Promise<void> {
  await execRun(db.insert(rulesTable).values({
    id, name: id, description: 'test rule', category: over.category ?? 'security', severity: over.severity ?? 'medium',
    enabled: over.enabled ?? true, scope: JSON.stringify(over.scope ?? { level: 'subscription' }),
    resourceTypes: JSON.stringify([]), conditions: JSON.stringify([]),
    rawKql: 'resources', type: 'custom', lastRunStatus: over.lastRunStatus === undefined ? 'success' : over.lastRunStatus,
    kind: 'state', queryBackend: over.queryBackend ?? 'resource-graph', tags: over.tags ? JSON.stringify(over.tags) : null,
  }));
}

const treeNode = (id: string, name: string, parentId: string | null, kind: HierarchyNode['kind'] = 'subscription'): HierarchyNode =>
  ({ tenantId: T, kind, id, name, parentId });

const grant = (kind: ScopeGrant['scope']['kind'], path: string): ScopeGrant => ({ tenantId: T, scope: { kind, path }, role: 'viewer' });
const holds = (...grants: ScopeGrant[]): Access => buildAccess(grants, 'manual');

const summaryFor = (filters: Partial<WidgetFilters> = {}, access: Access = EVERYTHING_ACCESS) =>
  computeWidgetSummary({ dateWindow: window, ...filters }, access);
const rowOf = (summary: Awaited<ReturnType<typeof summaryFor>>, id: string) => summary.perSubscription.find(r => r.subscriptionId === id);

beforeEach(async () => {
  await resetDb();
  await clearRules();
});

describe('the rows', () => {
  it('lists a subscription with no findings and one no rule covers, beside one with findings', async () => {
    await insertRule('r-a', { scope: { level: 'subscription', subscriptions: [SUB_A] } });
    await replaceHierarchy([treeNode('mg-root', 'Root', null, 'managementGroup'), treeNode(SUB_A, 'Alpha', 'mg-root'), treeNode(SUB_D, 'Delta', 'mg-root')], NOW);
    await storeScan([syntheticFinding('vm-a', [{ n: 1 }], { ruleId: 'r-a', subscriptionId: SUB_A })], { scanId: 's1', finishedAt: NOW });

    const summary = await summaryFor();
    expect(rowOf(summary, SUB_A)).toMatchObject({ name: 'Alpha', totalRules: 1, passingRules: 0, activeFindings: 1 });
    expect(rowOf(summary, SUB_D)).toMatchObject({ name: 'Delta', totalRules: 0, pct: null, activeFindings: 0 });
  });

  it('lists a subscription that only a rule\'s scope names, and one that only holds a finding', async () => {
    await insertRule('r-b', { scope: { level: 'subscription', subscriptions: [SUB_B] } });
    await insertRule('r-all');
    await storeScan([syntheticFinding('vm-c', [{ n: 1 }], { ruleId: 'r-all', subscriptionId: SUB_C })], { scanId: 's1', finishedAt: NOW });

    const summary = await summaryFor();
    expect(summary.perSubscription.map(r => r.subscriptionId).sort()).toEqual([SUB_B, SUB_C, 'directory'].sort());
  });

  it('counts a rule scoped to one subscription in that subscription\'s total and not in another\'s', async () => {
    await insertRule('r-a', { scope: { level: 'subscription', subscriptions: [SUB_A] } });
    await insertRule('r-all');
    await replaceHierarchy([treeNode(SUB_A, 'Alpha', null), treeNode(SUB_B, 'Beta', null)], NOW);

    const summary = await summaryFor();
    expect(rowOf(summary, SUB_A)).toMatchObject({ totalRules: 2, passingRules: 2, pct: 100 });
    expect(rowOf(summary, SUB_B)).toMatchObject({ totalRules: 1, passingRules: 1, pct: 100 });
  });

  it('grades a row by the findings placed inside it and by each rule\'s last run', async () => {
    await insertRule('r-fail');
    await insertRule('r-ok');
    await insertRule('r-unknown', { lastRunStatus: 'failed' });
    await replaceHierarchy([treeNode(SUB_A, 'Alpha', null), treeNode(SUB_B, 'Beta', null)], NOW);
    await storeScan([
      syntheticFinding('vm-1', [{ n: 1 }], { ruleId: 'r-fail', subscriptionId: SUB_A }),
      syntheticFinding('vm-2', [{ n: 2 }], { ruleId: 'r-fail', subscriptionId: SUB_A }),
    ], { scanId: 's1', finishedAt: NOW, ranRuleIds: ['r-fail'] });

    const summary = await summaryFor();
    expect(rowOf(summary, SUB_A)).toMatchObject({ totalRules: 3, passingRules: 1, unknownRules: 1, activeFindings: 2, pct: 33 });
    expect(rowOf(summary, SUB_B)).toMatchObject({ totalRules: 3, passingRules: 2, unknownRules: 1, activeFindings: 0 });
  });

  it('counts a finding in the row\'s findings even when its rule no longer overlaps the subscription, without failing a rule', async () => {
    await insertRule('r-b', { scope: { level: 'subscription', subscriptions: [SUB_B] } });
    await insertRule('r-all');
    await storeScan([syntheticFinding('vm-1', [{ n: 1 }], { ruleId: 'r-b', subscriptionId: SUB_A })], { scanId: 's1', finishedAt: NOW });

    expect(rowOf(await summaryFor(), SUB_A)).toMatchObject({ totalRules: 1, passingRules: 1, activeFindings: 1 });
  });

  it('leaves a suppressed finding out, so the rule it belongs to passes again', async () => {
    await insertRule('r-fail');
    await replaceHierarchy([treeNode(SUB_A, 'Alpha', null)], NOW);
    const finding = syntheticFinding('vm-1', [{ n: 1 }], { ruleId: 'r-fail', subscriptionId: SUB_A });
    await storeScan([finding], { scanId: 's1', finishedAt: NOW });
    await addSuppression({ id: 'sup-1', fingerprint: finding.fingerprint, reason: 'accepted', suppressedAt: NOW });

    expect(rowOf(await summaryFor(), SUB_A)).toMatchObject({ totalRules: 1, passingRules: 1, activeFindings: 0 });
  });

  it('keeps a Severity filter\'s rules in the total and fails a rule only on a finding of a picked severity', async () => {
    await insertRule('r-low');
    await replaceHierarchy([treeNode(SUB_A, 'Alpha', null)], NOW);
    await storeScan([syntheticFinding('vm-1', [{ n: 1 }], { ruleId: 'r-low', subscriptionId: SUB_A, severity: 'low' })], { scanId: 's1', finishedAt: NOW });

    expect(rowOf(await summaryFor({ severities: ['critical'] }), SUB_A)).toMatchObject({ totalRules: 1, passingRules: 1 });
    expect(rowOf(await summaryFor({ severities: ['low'] }), SUB_A)).toMatchObject({ totalRules: 1, passingRules: 0 });
  });

  it('lists only the subscriptions a subscription filter names', async () => {
    await insertRule('r-all');
    await replaceHierarchy([treeNode(SUB_A, 'Alpha', null), treeNode(SUB_B, 'Beta', null)], NOW);

    const summary = await summaryFor({ subscriptions: [SUB_B] });
    expect(summary.perSubscription.map(r => r.subscriptionId)).toEqual([SUB_B]);
  });
});

describe('the Directory row', () => {
  it('is graded by Microsoft Graph rules only, and the subscriptions do not count them', async () => {
    await insertRule('r-arm');
    await insertRule('r-graph', { queryBackend: 'microsoft-graph', lastRunStatus: 'success' });
    await replaceHierarchy([treeNode(SUB_A, 'Alpha', null)], NOW);
    await storeScan([syntheticFinding('app-1', [{ n: 1 }], { ruleId: 'r-graph', placement: 'directory' })], { scanId: 's1', finishedAt: NOW });

    const summary = await summaryFor();
    expect(rowOf(summary, 'directory')).toMatchObject({ directory: true, totalRules: 1, passingRules: 0, activeFindings: 1 });
    expect(rowOf(summary, SUB_A)).toMatchObject({ directory: false, totalRules: 1, passingRules: 1 });
  });

  it('has a total of 0 when no Graph rule is enabled', async () => {
    await insertRule('r-arm');
    expect(rowOf(await summaryFor(), 'directory')).toMatchObject({ totalRules: 0, pct: null });
  });

  it('is shown only to someone whose Access includes the Directory', async () => {
    await insertRule('r-graph', { queryBackend: 'microsoft-graph' });
    await insertRule('r-arm');
    const subscriptionOnly = holds(grant('subscription', `/subscriptions/${SUB_A}`));
    const withDirectory = holds(grant('subscription', `/subscriptions/${SUB_A}`), grant('directory', '@directory'));

    expect(rowOf(await summaryFor({}, subscriptionOnly), 'directory')).toBeUndefined();
    expect(rowOf(await summaryFor({}, withDirectory), 'directory')).toMatchObject({ directory: true, totalRules: 1 });
  });
});

describe('a person\'s Access', () => {
  it('lists only the subscriptions they hold, and counts only the rules that look at them', async () => {
    await insertRule('r-a', { scope: { level: 'subscription', subscriptions: [SUB_A] } });
    await insertRule('r-b', { scope: { level: 'subscription', subscriptions: [SUB_B] } });
    await replaceHierarchy([treeNode(SUB_A, 'Alpha', null), treeNode(SUB_B, 'Beta', null)], NOW);

    const summary = await summaryFor({}, holds(grant('subscription', `/subscriptions/${SUB_A}`)));
    expect(summary.perSubscription.map(r => r.subscriptionId)).toEqual([SUB_A]);
    expect(summary.perSubscription[0]).toMatchObject({ totalRules: 1, yourGroupsOnly: false });
  });

  it('counts a subscription held only through resource groups over that part, and says so', async () => {
    await insertRule('r-all');
    await storeScan([
      syntheticFinding('vm-mine', [{ n: 1 }], { ruleId: 'r-all', subscriptionId: SUB_A, resourceGroup: 'rg-mine' }),
      syntheticFinding('vm-theirs', [{ n: 2 }], { ruleId: 'r-all', subscriptionId: SUB_A, resourceGroup: 'rg-theirs' }),
    ], { scanId: 's1', finishedAt: NOW });

    const summary = await summaryFor({}, holds(grant('resourceGroup', `/subscriptions/${SUB_A}/resourceGroups/rg-mine`)));
    expect(summary.perSubscription).toHaveLength(1);
    expect(summary.perSubscription[0]).toMatchObject({ subscriptionId: SUB_A, yourGroupsOnly: true, activeFindings: 1, totalRules: 1, passingRules: 0 });
  });

  it('lists nothing for someone who holds no Scope', async () => {
    await insertRule('r-all');
    const summary = await summaryFor({}, holds());
    expect(summary.perSubscription).toEqual([]);
    expect(summary.emptyReason?.title).toBe(NO_ACCESS_HEADING);
  });
});

describe('the footer', () => {
  async function placedFixture() {
    await insertRule('r-all');
    await insertRule('r-low', { severity: 'low', tags: ['cost'] });
    await replaceHierarchy([treeNode(SUB_A, 'Alpha', null)], NOW);
    await storeScan([
      syntheticFinding('vm-a', [{ n: 1 }], { ruleId: 'r-all', subscriptionId: SUB_A }),
      syntheticFinding('mg-1', [{ n: 2 }], { ruleId: 'r-all', placement: 'management-group', severity: 'critical' }),
      syntheticFinding('mg-2', [{ n: 3 }], { ruleId: 'r-low', placement: 'management-group', severity: 'low' }),
      syntheticFinding('odd-1', [{ n: 4 }], { ruleId: 'r-all', placement: 'unplaceable', severity: 'high' }),
      syntheticFinding('app-1', [{ n: 5 }], { ruleId: 'r-all', placement: 'directory' }),
    ], { scanId: 's1', finishedAt: NOW, ranRuleIds: ['r-all', 'r-low'] });
  }

  /** The count of the Scans list the footer's link opens, read through the URL parser and the view engine. */
  async function scansCount(filters: WidgetFilters, access: Access = EVERYTHING_ACCESS): Promise<number> {
    const href = buildScansHref(filters, { status: 'open', placements: ['management-group', 'unplaceable'] });
    const view = viewFromSearchParams(new URL(href, 'http://localhost').searchParams);
    return (await queryView(view, { tab: 'results', showSuppressed: false }, access)).total;
  }

  it('counts findings at a management group or unplaced, and no subscription row counts a management group finding', async () => {
    await placedFixture();
    const summary = await summaryFor();
    expect(summary.outsideSubscriptions).toBe(3);
    expect(rowOf(summary, SUB_A)).toMatchObject({ activeFindings: 1 });
    expect(summary.perSubscription.reduce((n, r) => n + r.activeFindings, 0)).toBe(2);
  });

  it.each([
    ['no filter', {}],
    ['a category', { categories: ['security'] }],
    ['a severity', { severities: ['critical', 'low'] as WidgetFilters['severities'] }],
    ['a rule', { ruleIds: ['r-low'] }],
    ['a tag', { tags: ['cost'] }],
  ] as [string, Partial<WidgetFilters>][])('equals the count of the Scans list its link opens, narrowed by %s', async (_name, extra) => {
    await placedFixture();
    const filters = mergeWidgetFilters({ dateWindow: window, ...extra }, {});
    const summary = await summaryFor(extra);
    expect(summary.outsideSubscriptions).toBe(await scansCount(filters));
  });

  it('is narrowed by severity: a Critical filter leaves out the Low and High ones', async () => {
    await placedFixture();
    expect((await summaryFor({ severities: ['critical'] })).outsideSubscriptions).toBe(1);
  });

  it('leaves a suppressed finding out, as the Scans Open list does', async () => {
    await placedFixture();
    const mg = syntheticFinding('mg-1', [{ n: 2 }], { ruleId: 'r-all', placement: 'management-group', severity: 'critical' });
    await addSuppression({ id: 'sup-1', fingerprint: mg.fingerprint, reason: 'accepted', suppressedAt: NOW });
    const summary = await summaryFor();
    expect(summary.outsideSubscriptions).toBe(2);
    expect(summary.outsideSubscriptions).toBe(await scansCount(mergeWidgetFilters({ dateWindow: window }, {})));
  });

  it('is hidden under a subscription, resource group or Directory filter', async () => {
    await placedFixture();
    expect((await summaryFor({ subscriptions: [SUB_A] })).outsideSubscriptions).toBeNull();
    expect((await summaryFor({ subscriptions: ['directory'] })).outsideSubscriptions).toBeNull();
    expect((await summaryFor({ resourceGroups: ['rg-1'] })).outsideSubscriptions).toBeNull();
  });

  it('counts a management group finding for someone who holds the group, and not for someone who holds a subscription', async () => {
    await insertRule('r-all');
    await storeScan([
      syntheticFinding('mg-1', [{ n: 1 }], { ruleId: 'r-all', placement: 'management-group', managementGroupId: 'mg-held' }),
      syntheticFinding('vm-a', [{ n: 2 }], { ruleId: 'r-all', subscriptionId: SUB_A }),
    ], { scanId: 's1', finishedAt: NOW });
    const mgHolder = buildAccess([grant('managementGroup', '/providers/Microsoft.Management/managementGroups/mg-held')], 'manual', [
      { tenantId: T, path: '/providers/Microsoft.Management/managementGroups/mg-held', role: 'viewer', groups: ['mg-held'], subscriptions: [] },
    ]);
    const subHolder = holds(grant('subscription', `/subscriptions/${SUB_A}`));

    expect((await summaryFor({}, mgHolder)).outsideSubscriptions).toBe(1);
    expect((await summaryFor({}, subHolder)).outsideSubscriptions).toBe(0);
    const filters = mergeWidgetFilters({ dateWindow: window }, {});
    expect(await scansCount(filters, mgHolder)).toBe(1);
  });
});

describe('the notes', () => {
  it('always say how a rule counts for a subscription', async () => {
    await insertRule('r-all');
    expect((await summaryFor()).subscriptionNotes).toEqual([WIDGET_LIMITS.w2]);
  });

  it('add the management group note while a rule\'s group is not in the stored tree', async () => {
    await insertRule('r-mg', { scope: { level: 'managementGroup', managementGroups: ['mg-unknown'] } });
    await replaceHierarchy([treeNode('mg-known', 'Known', null, 'managementGroup'), treeNode(SUB_A, 'Alpha', 'mg-known')], NOW);
    expect((await summaryFor()).subscriptionNotes).toEqual([WIDGET_LIMITS.w2, WIDGET_LIMITS.w3]);
  });

  it('leave the management group note out once the tree holds the group, and count the rule for its subscriptions', async () => {
    await insertRule('r-mg', { scope: { level: 'managementGroup', managementGroups: ['mg-known'] } });
    await replaceHierarchy([
      treeNode('mg-known', 'Known', null, 'managementGroup'), treeNode(SUB_A, 'Alpha', 'mg-known'),
      treeNode(SUB_B, 'Beta', null),
    ], NOW);
    const summary = await summaryFor();
    expect(summary.subscriptionNotes).toEqual([WIDGET_LIMITS.w2]);
    expect(rowOf(summary, SUB_A)).toMatchObject({ totalRules: 1 });
    expect(rowOf(summary, SUB_B)).toMatchObject({ totalRules: 0 });
  });
});

describe('the order', () => {
  it('lists the lowest unrounded ratio first, then more findings, then name, with uncovered rows last', async () => {
    await insertRule('r-1');
    await insertRule('r-2');
    await insertRule('r-only-d', { scope: { level: 'subscription', subscriptions: [SUB_D] } });
    await replaceHierarchy([
      treeNode(SUB_A, 'Alpha', null), treeNode(SUB_B, 'Beta', null), treeNode(SUB_C, 'Gamma', null), treeNode(SUB_D, 'Delta', null),
    ], NOW);
    await storeScan([
      syntheticFinding('vm-1', [{ n: 1 }], { ruleId: 'r-1', subscriptionId: SUB_B }),
      syntheticFinding('vm-2', [{ n: 2 }], { ruleId: 'r-1', subscriptionId: SUB_B }),
      syntheticFinding('vm-3', [{ n: 3 }], { ruleId: 'r-1', subscriptionId: SUB_C }),
      syntheticFinding('vm-4', [{ n: 4 }], { ruleId: 'r-only-d', subscriptionId: SUB_D }),
    ], { scanId: 's1', finishedAt: NOW, ranRuleIds: ['r-1', 'r-only-d'] });

    const order = (await summaryFor()).perSubscription.map(r => r.name ?? r.subscriptionId);
    // Beta and Gamma pass 1 of 2 (Beta has more findings), Delta 2 of 3, Alpha 2 of 2; the Directory has no rule.
    expect(order).toEqual(['Beta', 'Gamma', 'Delta', 'Alpha', 'directory']);
  });
});
