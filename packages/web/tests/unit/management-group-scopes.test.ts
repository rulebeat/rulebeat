/**
 * #273: a management group Scope, end to end. A person holds a group as stored rows; what the group covers
 * comes from RuleBeat's copy of the management group tree, read by the real refresh from a fake reader (no
 * Azure). The findings a person sees come from the real access resolution and the real findings view.
 *
 * Own seed and own `resetDb()`. Every id is fake.
 *
 *   root (the tenant root group)
 *   ├── mg-parent
 *   │   ├── mg-child
 *   │   │   └── subscription C
 *   │   └── subscription A
 *   └── mg-beside
 *       ├── subscription B
 *       └── subscription D
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser, getUser } from '@/lib/db/users';
import { listAssignmentsFor, replaceAssignmentsOn } from '@/lib/db/role-assignments';
import { inTransaction } from '@/lib/db/exec';
import { queryView } from '@/lib/db/finding-views';
import { listHierarchyNodes, getHierarchyStatus, HIERARCHY_STATUS_KEY } from '@/lib/db/management-group-hierarchy';
import { getMeta } from '@/lib/db/meta';
import { resolveAccess } from '@/lib/access';
import { managementGroupScopePath } from '@/lib/access-picker';
import { refreshManagementGroupHierarchy } from '@/lib/management-group-hierarchy';
import { emptyView } from '@/lib/finding-view';
import type { Finding } from '@/lib/types';
import { fakeHierarchy, group, refreshFrom, subscription, HIERARCHY_TENANT as TENANT, type FakeHierarchy } from '../helpers/fake-hierarchy';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';

const SUB_A = '00000000-0000-0000-0000-00000000000a';
const SUB_B = '00000000-0000-0000-0000-00000000000b';
const SUB_C = '00000000-0000-0000-0000-00000000000c';
const SUB_D = '00000000-0000-0000-0000-00000000000d';
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000e1';
const RULE = 'mg-rule';

const tree = (): FakeHierarchy => fakeHierarchy([
  group(TENANT, 'Tenant Root Group', null),
  group('mg-parent', 'Parent', TENANT),
  group('mg-child', 'Child', 'mg-parent'),
  group('mg-beside', 'Beside', TENANT),
  subscription(SUB_A, 'Subscription A', 'mg-parent'),
  subscription(SUB_C, 'Subscription C', 'mg-child'),
  subscription(SUB_B, 'Subscription B', 'mg-beside'),
  subscription(SUB_D, 'Subscription D', 'mg-beside'),
]);

const at = (extra: Record<string, unknown> = {}) => ({ ruleId: RULE, category: 'security', ...extra });
// A second scan of another rule, so storing it resolves nothing the first scan stored.
const later = (extra: Record<string, unknown>) => at({ ruleId: 'later-rule', ...extra });

async function seedFindings(): Promise<void> {
  const findings: Finding[] = [
    syntheticFinding('vm-a', [{ zone: 'a' }], at({ subscriptionId: SUB_A, resourceGroup: 'rg-one' })),
    syntheticFinding('vm-b', [{ zone: 'a' }], at({ subscriptionId: SUB_B, resourceGroup: 'rg-one' })),
    syntheticFinding('vm-c', [{ zone: 'a' }], at({ subscriptionId: SUB_C, resourceGroup: 'rg-one' })),
    syntheticFinding('vm-d', [{ zone: 'a' }], at({ subscriptionId: SUB_D, resourceGroup: 'rg-one' })),
    syntheticFinding('subscription-a-level', [{ zone: 'a' }], at({ placement: 'subscription', subscriptionId: SUB_A })),
    syntheticFinding('workspace-c', [{ zone: 'a' }], at({ placement: 'workspace', subscriptionId: SUB_C, resourceGroup: 'rg-one' })),
    syntheticFinding('parent-level', [{ zone: 'a' }], at({ placement: 'management-group', managementGroupId: 'mg-parent' })),
    syntheticFinding('child-level', [{ zone: 'a' }], at({ placement: 'management-group', managementGroupId: 'mg-child' })),
    syntheticFinding('beside-level', [{ zone: 'a' }], at({ placement: 'management-group', managementGroupId: 'mg-beside' })),
    syntheticFinding('root-level', [{ zone: 'a' }], at({ placement: 'management-group', managementGroupId: TENANT })),
    syntheticFinding('directory-app', [{ zone: 'a' }], at({ placement: 'directory' })),
    syntheticFinding('unplaceable-thing', [{ zone: 'a' }], at({ placement: 'unplaceable' })),
  ];
  await storeScan(findings, { scanId: '00000000-0000-0000-0000-0000000000a1', finishedAt: '2026-06-01T00:00:00.000Z' });
}

let fake: FakeHierarchy;
let counter = 0;

/** A Viewer holding exactly these Scope paths, each stored under `tenantId`. */
async function viewerHolding(paths: string[], tenantId = TENANT): Promise<string> {
  const created = await createUser({ email: `person${counter++}@example.com`, role: 'viewer' });
  if ('error' in created) throw new Error(created.error);
  await inTransaction(tx => replaceAssignmentsOn(tx, created.user.id, paths.map(scope => ({ tenantId, scope, role: 'viewer' as const }))));
  return created.user.id;
}

/** The names of the findings the person sees across the Results, Advisories and Activity tabs, sorted. */
async function seenBy(userId: string): Promise<string[]> {
  const access = await resolveAccess((await getUser(userId))!);
  const names: string[] = [];
  for (const tab of ['results', 'advisories', 'activity'] as const) {
    const view = await queryView(emptyView(), { tab, showSuppressed: false }, access);
    names.push(...view.items.map(i => i.finding.resourceName ?? i.finding.dimensionKey ?? ''));
  }
  return names.sort();
}

const mg = managementGroupScopePath;

beforeEach(async () => {
  await resetDb();
  fake = tree();
  await seedFindings();
  await refreshFrom(fake);
});

describe('a management group Scope covers what is under it', () => {
  it('shows a person every subscription under the group at any depth, and the findings placed at the group or beneath it', async () => {
    const person = await viewerHolding([mg('mg-parent')]);
    expect(await seenBy(person)).toEqual([
      'child-level', 'parent-level', 'subscription-a-level', 'vm-a', 'vm-c', 'workspace-c',
    ]);
  });

  it('does not show the Directory, a finding RuleBeat could not place, or a group above or beside it', async () => {
    const seen = await seenBy(await viewerHolding([mg('mg-parent')]));
    for (const name of ['directory-app', 'unplaceable-thing', 'root-level', 'beside-level', 'vm-b', 'vm-d']) {
      expect(seen, name).not.toContain(name);
    }
  });

  it('shows a child group its own subscriptions and findings, and neither its parent\'s finding nor its parent\'s other subscriptions', async () => {
    expect(await seenBy(await viewerHolding([mg('mg-child')]))).toEqual(['child-level', 'vm-c', 'workspace-c']);
  });

  it('shows the tenant root group everything that sits under the tenant, and still not the Directory or the unplaceable', async () => {
    expect(await seenBy(await viewerHolding([mg(TENANT)]))).toEqual([
      'beside-level', 'child-level', 'parent-level', 'root-level', 'subscription-a-level', 'vm-a', 'vm-b', 'vm-c', 'vm-d', 'workspace-c',
    ]);
  });

  it('adds up with another Scope the person holds', async () => {
    const person = await viewerHolding([mg('mg-child'), `/subscriptions/${SUB_D}`, '@directory']);
    expect(await seenBy(person)).toEqual(['child-level', 'directory-app', 'vm-c', 'vm-d', 'workspace-c']);
  });
});

describe('the tree is RuleBeat\'s own copy, read again by a refresh', () => {
  it('covers a subscription moved under the group once a refresh has run, and not before, with no change to any row', async () => {
    const person = await viewerHolding([mg('mg-parent')]);
    const rowsBefore = await listAssignmentsFor(person);
    expect(await seenBy(person)).not.toContain('vm-b');

    // Azure now has the subscription under the group, but RuleBeat has not read it.
    fake.nodes = fake.nodes.map(n => (n.id === SUB_B ? { ...n, parentId: 'mg-parent' } : n));
    expect(await seenBy(person)).not.toContain('vm-b');

    await refreshFrom(fake);
    expect(await seenBy(person)).toContain('vm-b');
    expect(await seenBy(person)).not.toContain('vm-d');
    expect(await listAssignmentsFor(person)).toEqual(rowsBefore);
  });

  it('stops covering a subscription moved out of the group, again with no change to any row', async () => {
    const person = await viewerHolding([mg('mg-parent')]);
    const rowsBefore = await listAssignmentsFor(person);
    fake.nodes = fake.nodes.map(n => (n.id === SUB_A ? { ...n, parentId: 'mg-beside' } : n));
    await refreshFrom(fake);
    expect(await seenBy(person)).not.toContain('vm-a');
    expect(await listAssignmentsFor(person)).toEqual(rowsBefore);
  });

  it('covers a subscription that appears under the group after the grant was made', async () => {
    const person = await viewerHolding([mg('mg-child')]);
    fake.nodes = [...fake.nodes, subscription('00000000-0000-0000-0000-00000000000e', 'Subscription E', 'mg-child')];
    await storeScan([syntheticFinding('vm-e', [{ zone: 'a' }], later({ subscriptionId: '00000000-0000-0000-0000-00000000000e', resourceGroup: 'rg-one' }))],
      { scanId: '00000000-0000-0000-0000-0000000000a2', finishedAt: '2026-06-02T00:00:00.000Z' });
    expect(await seenBy(person)).not.toContain('vm-e');
    await refreshFrom(fake);
    expect(await seenBy(person)).toContain('vm-e');
  });

  describe('a refresh whose read throws', () => {
    const LEAK = 'AuthorizationFailed: client 00000000-aaaa-bbbb-cccc-000000000000 has no access to /subscriptions/secret-sub';
    let quiet: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined); });

    it('leaves the stored tree as it was, and everyone sees what they saw before', async () => {
      const parent = await viewerHolding([mg('mg-parent')]);
      const child = await viewerHolding([mg('mg-child')]);
      const treeBefore = await listHierarchyNodes();
      const seenBefore = [await seenBy(parent), await seenBy(child)];

      fake.nodes = fake.nodes.map(n => (n.id === SUB_B ? { ...n, parentId: 'mg-parent' } : n));
      fake.failWith = new Error(LEAK);
      const result = await refreshManagementGroupHierarchy({ read: fake.read, now: new Date('2026-06-03T00:00:00.000Z') });

      expect(result.ok).toBe(false);
      expect(await listHierarchyNodes()).toEqual(treeBefore);
      expect([await seenBy(parent), await seenBy(child)]).toEqual(seenBefore);
      quiet.mockRestore();
    });

    it('records a stable message, and neither the stored status nor the result holds the thrown text', async () => {
      fake.failWith = new Error(LEAK);
      const result = await refreshManagementGroupHierarchy({ read: fake.read, now: new Date('2026-06-03T00:00:00.000Z') });

      const status = await getHierarchyStatus();
      expect(status).toEqual({
        lastSuccessAt: '2026-06-02T00:00:00.000Z',
        lastAttemptAt: '2026-06-03T00:00:00.000Z',
        error: { code: 'failed', message: 'The management group tree could not be read from Azure. Check the RuleBeat server logs for details.' },
      });
      const stored = await getMeta(HIERARCHY_STATUS_KEY);
      for (const text of [JSON.stringify(result), JSON.stringify(status), stored ?? '']) {
        expect(text).not.toMatch(/AuthorizationFailed|00000000-aaaa|secret-sub/);
      }
      expect(quiet).toHaveBeenCalled();
      quiet.mockRestore();
    });
  });
});

describe('what a grant is compared against', () => {
  it('covers nothing under another tenant id, even for a group the cache holds under this one', async () => {
    const person = await viewerHolding([mg('mg-parent')], OTHER_TENANT);
    expect(await seenBy(person)).toEqual([]);
  });

  it('uses only the cache rows of the grant\'s own tenant', async () => {
    // The same group name under a second tenant, with a subscription of its own, must not add to the first tenant's group.
    fake.nodes = [
      ...fake.nodes,
      group('mg-parent', 'Parent', null, OTHER_TENANT),
      subscription(SUB_D, 'Subscription D', 'mg-parent', OTHER_TENANT),
    ];
    await refreshFrom(fake);
    const seen = await seenBy(await viewerHolding([mg('mg-parent')]));
    expect(seen).toContain('vm-a');
    expect(seen).not.toContain('vm-d');
  });

  it('covers nothing for a group the cache does not hold', async () => {
    expect(await seenBy(await viewerHolding([mg('mg-unknown')]))).toEqual([]);
  });

  it('compares group ids and subscription ids without regard to case', async () => {
    fake.nodes = [
      group(TENANT, 'Tenant Root Group', null),
      group('MG-Upper', 'Upper', TENANT),
      subscription(SUB_A.toUpperCase(), 'Subscription A', 'mg-upper'),
    ];
    await refreshFrom(fake);
    await storeScan([syntheticFinding('upper-level', [{ zone: 'a' }], later({ placement: 'management-group', managementGroupId: 'MG-UPPER' }))],
      { scanId: '00000000-0000-0000-0000-0000000000a3', finishedAt: '2026-06-03T00:00:00.000Z' });

    const seen = await seenBy(await viewerHolding([mg('mg-UPPER')]));
    expect(seen).toEqual(expect.arrayContaining(['vm-a', 'subscription-a-level', 'upper-level']));
    expect(seen).not.toContain('vm-c');
  });

  it('stops at a loop in the tree', async () => {
    fake.nodes = [
      group(TENANT, 'Tenant Root Group', null),
      group('mg-parent', 'Parent', 'mg-child'),
      group('mg-child', 'Child', 'mg-parent'),
      subscription(SUB_A, 'Subscription A', 'mg-child'),
    ];
    await refreshFrom(fake);
    expect(await seenBy(await viewerHolding([mg('mg-parent')]))).toEqual(expect.arrayContaining(['vm-a', 'child-level', 'parent-level']));
  });
});
