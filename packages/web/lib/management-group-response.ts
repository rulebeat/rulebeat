import { listHierarchyNodes, getHierarchyStatus } from '@/lib/db/management-group-hierarchy';
import type { HierarchyView } from '@/lib/management-group-tree';

/** The tree RuleBeat holds and how its last refresh went, as the routes answer it. */
export async function hierarchyResponse(): Promise<HierarchyView> {
  const [nodes, status] = await Promise.all([listHierarchyNodes(), getHierarchyStatus()]);
  return { nodes: nodes.map(n => ({ id: n.id, kind: n.kind, name: n.name, parentId: n.parentId })), status };
}
