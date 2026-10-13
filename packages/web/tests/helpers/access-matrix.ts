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
import { saveScanResult } from '@/lib/scan-history';
import { addSuppression } from '@/lib/suppressions';
import { finishRun, startRun } from '@/lib/schedule-runs';
import type { Role } from '@/lib/rbac';
import type { Finding, ScanSummary } from '@/lib/types';
import { emptySeverityCounts } from '@/lib/severity';
import { syntheticFinding } from './synthetic-findings';

export const MATRIX_TENANT = '00000000-0000-0000-0000-0000000000f0';
export const SUB_ONE = '00000000-0000-0000-0000-00000000000a';
export const SUB_TWO = '00000000-0000-0000-0000-00000000000b';
export const MANAGEMENT_GROUP = 'mg-example';
const RG_ONE = 'rg-one';
const RG_TWO = 'rg-two';
const RULE = 'matrix-rule';
const CATEGORY = 'security';

export const SCOPE_MANAGEMENT_GROUP = `/providers/Microsoft.Management/managementGroups/${MANAGEMENT_GROUP}`;
export const SCOPE_SUBSCRIPTION = `/subscriptions/${SUB_ONE}`;
export const SCOPE_RESOURCE_GROUP = `/subscriptions/${SUB_ONE}/resourceGroups/${RG_ONE}`;
export const SCOPE_DIRECTORY = '@directory';

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
}

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

/** Two subscriptions under one management group, a finding at each placement, two scans of one category,
 *  one suppression, one schedule and one run. */
export async function seedMatrix(): Promise<MatrixSeed> {
  const at = { ruleId: RULE, category: CATEGORY };
  const all: Finding[] = [
    syntheticFinding('vm-one', [{ zone: 'a' }], { ...at, subscriptionId: SUB_ONE, resourceGroup: RG_ONE }),
    syntheticFinding('vm-two', [{ zone: 'b' }], { ...at, subscriptionId: SUB_ONE, resourceGroup: RG_TWO }),
    syntheticFinding('vm-other-sub', [{ zone: 'a' }], { ...at, subscriptionId: SUB_TWO, resourceGroup: RG_ONE }),
    syntheticFinding('subscription-level', [{ zone: 'a' }], { ...at, placement: 'subscription', subscriptionId: SUB_ONE }),
    syntheticFinding('management-group-level', [{ zone: 'a' }], { ...at, placement: 'management-group', managementGroupId: MANAGEMENT_GROUP }),
    syntheticFinding('directory-app', [{ zone: 'a' }], { ...at, placement: 'directory' }),
    syntheticFinding('workspace-user', [{ zone: 'a' }], { ...at, placement: 'workspace', subscriptionId: SUB_ONE }),
    syntheticFinding('unplaceable-thing', [{ zone: 'a' }], { ...at, placement: 'unplaceable' }),
  ];

  const scanIds: [string, string] = ['00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2'];
  const first = all.slice(0, 5);
  const stored: [string, string, Finding[]][] = [
    [scanIds[0], '2026-06-01T00:00:00.000Z', first],
    [scanIds[1], '2026-06-02T00:00:00.000Z', all],
  ];
  for (const [id, finishedAt, findings] of stored) {
    await saveScanResult(CATEGORY, summaryOf(id, finishedAt, findings), { id });
    await syncScanFindings({ scanId: id, category: CATEGORY, ranRuleIds: [RULE], findings, finishedAt });
  }

  const suppressedFingerprint = all[1]!.fingerprint;
  await addSuppression({
    id: '00000000-0000-0000-0000-0000000000b1',
    fingerprint: suppressedFingerprint,
    resourceId: all[1]!.resourceId,
    reason: 'accepted for the matrix',
    suppressedAt: '2026-06-02T00:00:00.000Z',
  });

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

  return { scanIds, scheduleId: created.schedule.id, runId: run.id, suppressedFingerprint };
}
