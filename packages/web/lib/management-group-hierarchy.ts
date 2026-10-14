import { armFetch, getArmTenantId, getArmToken } from '@/lib/arm';
import { recordFailedAttempt, replaceHierarchy } from '@/lib/db/management-group-hierarchy';
import type { HierarchyNode, RefreshError, RefreshErrorCode } from '@/lib/management-group-tree';
import { refreshError } from '@/lib/management-group-tree';

/** What a reader returns: every node of the tenant's tree, the tenant root group included. */
export type HierarchyReader = () => Promise<HierarchyNode[]>;

interface RawChild {
  name: string;
  type: string;
  displayName?: string;
  children?: RawChild[] | null;
}

const ROOT_DISPLAY_NAME = 'Tenant Root Group';

function flatten(tenantId: string, parentId: string, children: RawChild[], into: HierarchyNode[]): void {
  for (const child of children) {
    const isSubscription = child.type === '/subscriptions';
    into.push({
      tenantId,
      kind: isSubscription ? 'subscription' : 'managementGroup',
      id: child.name,
      name: child.displayName ?? child.name,
      parentId,
    });
    if (!isSubscription && child.children?.length) flatten(tenantId, child.name, child.children, into);
  }
}

/**
 * Reads the tree from ARM with the call `GET /api/azure/scope-tree` makes: the tenant root group with its
 * children, recursively. The tenant root group is a node of its own, so a Scope on it can be chosen.
 */
export const readHierarchyFromArm: HierarchyReader = async () => {
  const tenantId = await getArmTenantId();
  const token = await getArmToken();
  const data = await armFetch<{
    name: string;
    properties: { displayName?: string; children?: RawChild[] | null };
  }>(
    `https://management.azure.com/providers/Microsoft.Management/managementGroups/${tenantId}?api-version=2020-05-01&$expand=children&$recurse=true`,
    token,
  );
  const nodes: HierarchyNode[] = [{
    tenantId,
    kind: 'managementGroup',
    id: tenantId,
    name: data.properties?.displayName ?? ROOT_DISPLAY_NAME,
    parentId: null,
  }];
  flatten(tenantId, tenantId, data.properties?.children ?? [], nodes);
  return nodes;
};

export type RefreshResult =
  | { ok: true; groups: number; subscriptions: number }
  | { ok: false; error: RefreshError };

function failureCode(err: unknown): RefreshErrorCode {
  return err instanceof Error && (err as { code?: string }).code === 'azure_not_configured' ? 'azure_not_configured' : 'failed';
}

/**
 * Reads the tree and replaces RuleBeat's copy of it. A successful read replaces every row at once. A read
 * that throws changes no row: the attempt is recorded with a message that names nothing, and the error
 * itself goes to the server log only. Never throws, so a caller that is also doing other work (the
 * scheduler's tick) is not stopped by it.
 */
export async function refreshManagementGroupHierarchy(
  opts: { read?: HierarchyReader; now?: Date } = {},
): Promise<RefreshResult> {
  const read = opts.read ?? readHierarchyFromArm;
  const at = (opts.now ?? new Date()).toISOString();
  try {
    const nodes = await read();
    await replaceHierarchy(nodes, at);
    return {
      ok: true,
      groups: nodes.filter(n => n.kind === 'managementGroup').length,
      subscriptions: nodes.filter(n => n.kind === 'subscription').length,
    };
  } catch (err) {
    const code = failureCode(err);
    if (code === 'failed') console.error('[RuleBeat] Management group tree refresh failed:', err);
    try {
      await recordFailedAttempt(code, at);
    } catch (recordErr) {
      console.error('[RuleBeat] Could not record the management group tree refresh:', recordErr);
    }
    return { ok: false, error: refreshError(code) };
  }
}
