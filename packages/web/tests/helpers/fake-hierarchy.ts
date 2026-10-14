/**
 * A fake management group tree for tests (#273): plain data and a reader over it, in place of Azure. The
 * data can be changed between refreshes, which is how a test moves a subscription under another group, and
 * the reader can be made to throw, which is how a test fails a refresh. Every id is fake.
 */
import { refreshManagementGroupHierarchy, type HierarchyReader } from '@/lib/management-group-hierarchy';
import type { HierarchyNode } from '@/lib/management-group-tree';

export const HIERARCHY_TENANT = '00000000-0000-0000-0000-0000000000f0';

export const group = (id: string, name: string, parentId: string | null, tenantId = HIERARCHY_TENANT): HierarchyNode =>
  ({ tenantId, kind: 'managementGroup', id, name, parentId });

export const subscription = (id: string, name: string, parentId: string, tenantId = HIERARCHY_TENANT): HierarchyNode =>
  ({ tenantId, kind: 'subscription', id, name, parentId });

export interface FakeHierarchy {
  /** What the next read returns. Replace it to change the tree Azure would answer with. */
  nodes: HierarchyNode[];
  /** When set, the next reads throw it. */
  failWith: Error | null;
  /** How many times the reader was called. */
  calls: number;
  read: HierarchyReader;
}

export function fakeHierarchy(nodes: HierarchyNode[]): FakeHierarchy {
  const fake: FakeHierarchy = {
    nodes,
    failWith: null,
    calls: 0,
    read: async () => {
      fake.calls += 1;
      if (fake.failWith) throw fake.failWith;
      return fake.nodes.map(n => ({ ...n }));
    },
  };
  return fake;
}

/** Runs the real refresh over the fake and fails the test if it did not succeed. */
export async function refreshFrom(fake: FakeHierarchy, now = new Date('2026-06-02T00:00:00.000Z')): Promise<void> {
  const result = await refreshManagementGroupHierarchy({ read: fake.read, now });
  if (!result.ok) throw new Error('the fake hierarchy refresh failed');
}
