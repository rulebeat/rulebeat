import { EVERYTHING_TENANT_ID, managementGroupIdOf, parseScope, type ManualGrant } from '@/lib/access-model';
import type { AssignmentInput } from '@/lib/db/role-assignments';
import { listHierarchyNodes } from '@/lib/db/management-group-hierarchy';
import { hasManagementGroup } from '@/lib/management-group-tree';
import { getArmTenantId } from '@/lib/arm';

export const NO_AZURE_CONNECTION_MESSAGE =
  'Connect Azure before giving access to a management group, a subscription, a resource group or the Directory.';

export const UNKNOWN_MANAGEMENT_GROUP_MESSAGE =
  'A management group in this list is not in the tree RuleBeat has loaded. Refresh the tree, then choose it again, or remove it.';

export type AssignmentsResult = { ok: true; assignments: AssignmentInput[] } | { ok: false; error: string };

/**
 * The rows to store for the Scopes an Admin chose. Everything keeps `EVERYTHING_TENANT_ID`: it covers
 * the install, not one tenant. Every other Scope is stored under the tenant RuleBeat is connected to,
 * which is resolved here and never read from the request: a body that named another tenant would
 * otherwise write a row for it. With no Azure connection there is no tenant id to store, so the
 * request is refused with a message that says what to do.
 *
 * A management group is stored only when the tree RuleBeat holds has it under that tenant. A row for a group
 * the tree lacks would cover nothing and look like it covered something, so it is refused, without naming it.
 */
export async function assignmentsFor(grants: readonly ManualGrant[]): Promise<AssignmentsResult> {
  const needsTenant = grants.some(g => parseScope(g.scope)?.kind !== 'everything');
  let tenantId = EVERYTHING_TENANT_ID;
  if (needsTenant) {
    try {
      tenantId = await getArmTenantId();
    } catch (err) {
      if (err instanceof Error && (err as { code?: string }).code === 'azure_not_configured') {
        return { ok: false, error: NO_AZURE_CONNECTION_MESSAGE };
      }
      throw err;
    }
  }
  const groups = grants.filter(g => parseScope(g.scope)?.kind === 'managementGroup');
  if (groups.length > 0) {
    const nodes = await listHierarchyNodes();
    if (!groups.every(g => hasManagementGroup(nodes, tenantId, managementGroupIdOf(g.scope)))) {
      return { ok: false, error: UNKNOWN_MANAGEMENT_GROUP_MESSAGE };
    }
  }
  return {
    ok: true,
    assignments: grants.map(g => ({
      tenantId: parseScope(g.scope)?.kind === 'everything' ? EVERYTHING_TENANT_ID : tenantId,
      scope: g.scope,
      role: g.role,
    })),
  };
}
