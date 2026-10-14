/**
 * The data set and the people the access matrix runs against (#270). One seed written through the real
 * write paths (a scan save, the findings sync, the suppression store, a schedule and a run), and seven
 * people who each hold a different Scope, created the way `require-role-access.test.ts` creates them.
 *
 * Every id is fake: zero GUIDs, `example.com`, made-up group names.
 */
import { createUser } from '@/lib/db/users';
import { deleteAssignmentsOn, grantAssignmentOn } from '@/lib/db/role-assignments';
import { inTransaction } from '@/lib/db/exec';
import { createSchedule } from '@/lib/db/schedules';
import { syncScanFindings } from '@/lib/db/findings';
import { upsertDailySnapshot } from '@/lib/db/snapshots';
import { createSavedView } from '@/lib/db/saved-views';
import { createDashboard, deleteDashboard, listDashboards } from '@/lib/db/dashboards';
import { emptyView, viewToSearchParams } from '@/lib/finding-view';
import { saveScanResult } from '@/lib/scan-history';
import { addSuppression } from '@/lib/suppressions';
import { finishRun, startRun } from '@/lib/schedule-runs';
import type { Role } from '@/lib/rbac';
import type { Finding, ScanSummary } from '@/lib/types';
import { emptySeverityCounts } from '@/lib/severity';
import { syntheticFinding } from './synthetic-findings';
import { fakeHierarchy, group, refreshFrom, subscription, type FakeHierarchy } from './fake-hierarchy';

export const MATRIX_TENANT = '00000000-0000-0000-0000-0000000000f0';
export const SUB_ONE = '00000000-0000-0000-0000-00000000000a';
export const SUB_TWO = '00000000-0000-0000-0000-00000000000b';
export const MANAGEMENT_GROUP = 'mg-example';
const RG_ONE = 'rg-one';
const RG_TWO = 'rg-two';
const RULE = 'matrix-rule';
const DASHBOARD_NAME = 'Subscription two dashboard';
const ADVISORY_RULE = 'matrix-advisory-rule';
const CATEGORY = 'security';

export const SCOPE_MANAGEMENT_GROUP = `/providers/Microsoft.Management/managementGroups/${MANAGEMENT_GROUP}`;
export const SCOPE_SUBSCRIPTION = `/subscriptions/${SUB_ONE}`;
export const SCOPE_RESOURCE_GROUP = `/subscriptions/${SUB_ONE}/resourceGroups/${RG_ONE}`;
export const SCOPE_DIRECTORY = '@directory';

/**
 * The tree Azure would answer with: the tenant root group, `mg-example` under it, and both subscriptions
 * under `mg-example`. A test that moves a subscription changes `nodes` on this and refreshes again.
 */
export function matrixHierarchy(): FakeHierarchy {
  return fakeHierarchy([
    group(MATRIX_TENANT, 'Tenant Root Group', null, MATRIX_TENANT),
    group(MANAGEMENT_GROUP, 'Example group', MATRIX_TENANT, MATRIX_TENANT),
    subscription(SUB_ONE, 'Subscription one', MANAGEMENT_GROUP, MATRIX_TENANT),
    subscription(SUB_TWO, 'Subscription two', MANAGEMENT_GROUP, MATRIX_TENANT),
  ]);
}

export interface PersonSpec {
  name: string;
  role: Role;
  /** Scope paths the person holds the Role at. Empty is a person with no Scope at all. */
  scopes: string[] | 'everything';
}

export const PEOPLE: PersonSpec[] = [
  { name: 'Admin', role: 'admin', scopes: 'everything' },
  { name: 'Editor on Everything', role: 'editor', scopes: 'everything' },
  { name: 'Viewer on the management group', role: 'viewer', scopes: [SCOPE_MANAGEMENT_GROUP] },
  { name: 'Viewer on one subscription', role: 'viewer', scopes: [SCOPE_SUBSCRIPTION] },
  { name: 'Viewer on one resource group', role: 'viewer', scopes: [SCOPE_RESOURCE_GROUP] },
  { name: 'Directory only', role: 'viewer', scopes: [SCOPE_DIRECTORY] },
  { name: 'No Scope', role: 'viewer', scopes: [] },
];

/** Creates one user per person and returns the user ids by person name. */
export async function createPeople(): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const [i, person] of PEOPLE.entries()) {
    const created = await createUser({ email: `person${i}@example.com`, role: person.role });
    if ('error' in created) throw new Error(created.error);
    const id = created.user.id;
    if (person.scopes !== 'everything') {
      const scopes = person.scopes;
      await inTransaction(async tx => {
        await deleteAssignmentsOn(tx, id);
        for (const scope of scopes) await grantAssignmentOn(tx, id, MATRIX_TENANT, scope, person.role);
      });
    }
    ids[person.name] = id;
  }
  return ids;
}

export interface MatrixSeed {
  scanIds: [string, string];
  scheduleId: string;
  runId: string;
  suppressedFingerprint: string;
  /** Every stored finding's fingerprint, by the name it was seeded with. */
  fingerprints: Record<string, string>;
  /** A saved view filtered to subscription two. */
  savedViewId: string;
  /** A dashboard filtered to subscription two, with one widget that overrides the resource group. */
  dashboardId: string;
}

/** The day each of the two stored snapshots is for, written by the real `upsertDailySnapshot`. */
export const SNAPSHOT_DAYS = ['2026-06-01', '2026-06-02'] as const;
/** A clock reading after both snapshot days, for a probe that reads a rolling window. */
export const MATRIX_NOW = '2026-06-10T12:00:00.000Z';
/** The resource group the seeded dashboard's widget overrides. */
export const WIDGET_RESOURCE_GROUP = RG_TWO;

function summaryOf(id: string, finishedAt: string, findings: Finding[]): ScanSummary {
  return {
    id,
    module: CATEGORY,
    startedAt: finishedAt,
    finishedAt,
    durationMs: 1000,
    subscriptionsScanned: [SUB_ONE, SUB_TWO],
    findings,
    counts: { ...emptySeverityCounts(), high: findings.length },
    totalRules: 1,
    triggeredBy: 'manual',
    coverage: 'complete',
    incompleteRules: [],
  };
}

/**
 * Two subscriptions under one management group (read into RuleBeat's copy of the tree by the real refresh,
 * from `matrixHierarchy()`) and a finding at each placement, two scans of one category, one suppression,
 * one schedule and one run. By tab:
 *
 *  - Results: `vm-one` (subscription one, `rg-one`), `vm-two` (subscription one, `rg-two`, suppressed),
 *    `vm-other-sub` (subscription two, also `rg-one`, with a column no other finding returns),
 *    `subscription-level`, `management-group-level`, `directory-app` and `unplaceable-thing`.
 *  - Advisories: `advisory-one` (subscription one, `rg-one`) and `advisory-other-sub` (subscription two).
 *  - Activity: `workspace-user` (a workspace in subscription one, `rg-one`).
 */
export async function seedMatrix(): Promise<MatrixSeed> {
  await refreshFrom(matrixHierarchy());
  const at = { ruleId: RULE, category: CATEGORY };
  const all: Finding[] = [
    syntheticFinding('vm-one', [{ zone: 'a' }], { ...at, subscriptionId: SUB_ONE, resourceGroup: RG_ONE }),
    syntheticFinding('vm-two', [{ zone: 'b' }], { ...at, subscriptionId: SUB_ONE, resourceGroup: RG_TWO }),
    syntheticFinding('vm-other-sub', [{ zone: 'a', otherSubColumn: 'x' }], { ...at, subscriptionId: SUB_TWO, resourceGroup: RG_ONE }),
    syntheticFinding('subscription-level', [{ zone: 'a' }], { ...at, placement: 'subscription', subscriptionId: SUB_ONE }),
    syntheticFinding('management-group-level', [{ zone: 'a' }], { ...at, placement: 'management-group', managementGroupId: MANAGEMENT_GROUP }),
    syntheticFinding('directory-app', [{ zone: 'a' }], { ...at, placement: 'directory' }),
    syntheticFinding('workspace-user', [{ zone: 'a' }], { ...at, placement: 'workspace', subscriptionId: SUB_ONE, resourceGroup: RG_ONE }),
    syntheticFinding('unplaceable-thing', [{ zone: 'a' }], { ...at, placement: 'unplaceable' }),
    syntheticFinding('advisory-one', [{ zone: 'a' }], { ruleId: ADVISORY_RULE, category: CATEGORY, kind: 'advisory', subscriptionId: SUB_ONE, resourceGroup: RG_ONE }),
    syntheticFinding('advisory-other-sub', [{ zone: 'a' }], { ruleId: ADVISORY_RULE, category: CATEGORY, kind: 'advisory', subscriptionId: SUB_TWO, resourceGroup: RG_ONE }),
  ];

  const scanIds: [string, string] = ['00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2'];
  const first = all.slice(0, 5);
  const stored: [string, string, Finding[]][] = [
    [scanIds[0], '2026-06-01T00:00:00.000Z', first],
    [scanIds[1], '2026-06-02T00:00:00.000Z', all],
  ];
  for (const [id, finishedAt, findings] of stored) {
    await saveScanResult(CATEGORY, summaryOf(id, finishedAt, findings), { id });
    await syncScanFindings({ scanId: id, category: CATEGORY, ranRuleIds: [RULE, ADVISORY_RULE], findings, finishedAt });
    if (finishedAt.startsWith(SNAPSHOT_DAYS[0])) await upsertDailySnapshot(CATEGORY, new Date(finishedAt));
  }

  const suppressedFingerprint = all[1]!.fingerprint;
  await addSuppression({
    id: '00000000-0000-0000-0000-0000000000b1',
    fingerprint: suppressedFingerprint,
    resourceId: all[1]!.resourceId,
    reason: 'accepted for the matrix',
    suppressedAt: '2026-06-02T00:00:00.000Z',
  });
  await upsertDailySnapshot(CATEGORY, new Date(stored[1]![1]));

  const view = await createSavedView({
    name: 'Subscription two only', tab: 'results',
    query: viewToSearchParams({ ...emptyView(), filters: [{ field: 'subscription', values: [SUB_TWO] }] }).toString(),
  }, null);
  if (!view.ok) throw new Error(view.reason);
  // resetDb keeps the seeded dashboards table, so a second seeding replaces the one it wrote before.
  for (const existing of await listDashboards()) if (existing.name === DASHBOARD_NAME) await deleteDashboard(existing.id);
  const dashboard = await createDashboard({
    name: DASHBOARD_NAME,
    config: {
      filters: { subscriptions: [SUB_TWO] },
      widgets: [{ id: 'matrix-widget', type: 'stat-card', title: 'Findings', x: 0, y: 0, w: 4, h: 2, config: { resourceGroups: [WIDGET_RESOURCE_GROUP] } }],
    },
  });
  if (!dashboard.ok) throw new Error(dashboard.reason);

  const created = await createSchedule({
    name: 'Matrix schedule', targetType: 'all', targetValues: [], recurrenceType: 'daily', interval: 1,
    daysOfWeek: null, dayOfMonth: null, startAt: '2026-06-01T00:00:00.000Z', endType: 'never', endDate: null,
  });
  if ('error' in created) throw new Error(created.error);
  const run = await startRun({ scheduleId: created.schedule.id, triggeredBy: 'schedule', categories: [CATEGORY], now: new Date('2026-06-02T00:00:00.000Z') });
  await finishRun(run.id, {
    status: 'success', totalFindings: all.length, newFindings: 0, newFindingFingerprints: [], durationMs: 1000,
    now: new Date('2026-06-02T00:01:00.000Z'),
  });

  const fingerprints = Object.fromEntries(all.map(f => [f.resourceName ?? f.dimensionKey!, f.fingerprint]));
  return { scanIds, scheduleId: created.schedule.id, runId: run.id, suppressedFingerprint, fingerprints, savedViewId: view.view.id, dashboardId: dashboard.dashboard.id };
}
