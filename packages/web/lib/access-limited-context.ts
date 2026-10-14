import { resolveWorkspacePlacement, type QueryScope, type TenantContext } from '@rulebeat/core';
import { accessReach, type Access } from './access-model';
import type { HierarchyNode } from './management-group-tree';
import { placedInside, scopeForRule } from './run-scope';
import { NEEDS_DIRECTORY_MESSAGE, NEEDS_WORKSPACE_SCOPE_MESSAGE } from './written-query';

export const OUTSIDE_ACCESS_REQUEST_MESSAGE =
  'This request does not overlap your access, so it was not sent to Azure.';

/**
 * The outer limit on every context `createTenantContext(access)` hands out for anything short of
 * Everything (#267). The routes and the scan runner still narrow each request to the action's own
 * Role first (`lib/written-query.ts`, `lib/scan-runner.ts`); this is the floor under them, so a new
 * route that forgets to never reaches outside what the person holds at any Role.
 *
 *  - Resource Graph is sent the overlap of the request and the person's subscriptions, management
 *    groups and the subscriptions holding their resource groups (`scopeForRule()`), and a request
 *    that shares nothing with them is refused rather than sent empty.
 *  - Microsoft Graph needs the Directory.
 *  - Log Analytics needs a Scope covering the workspace, looked up once through the unlimited
 *    context: the lookup is RuleBeat's own, and only its answer is used.
 *
 * `subscriptionIds` and `credential` are left as they are: only provider metadata reads them.
 * `loadHierarchy` is read only when a request names a management group the person does not hold.
 */
export function limitContextToAccess(
  ctx: TenantContext, access: Access, loadHierarchy: () => Promise<HierarchyNode[]>,
): TenantContext {
  if (access.everything) return ctx;
  const reach = accessReach(access);
  let workspaceCovered: Promise<boolean> | undefined;

  return {
    ...ctx,
    queryARG: async <TRow = Record<string, unknown>>(kql: string, scope?: QueryScope) => {
      const hierarchy = scope?.managementGroups?.length ? await loadHierarchy() : [];
      const limited = scopeForRule(scope, access, hierarchy);
      if (!limited) throw new Error(OUTSIDE_ACCESS_REQUEST_MESSAGE);
      return ctx.queryARG<TRow>(kql, limited);
    },
    graphGet: async <TValue = Record<string, unknown>>(path: string) => {
      if (!access.directory) throw new Error(NEEDS_DIRECTORY_MESSAGE);
      return ctx.graphGet<TValue>(path);
    },
    queryLogs: async <TRow = Record<string, unknown>>(kql: string) => {
      workspaceCovered ??= resolveWorkspacePlacement(ctx).then(placement =>
        placement !== null && placement.subscriptionId !== '' && placedInside(reach, { placement: 'workspace', ...placement }));
      if (!await workspaceCovered) throw new Error(NEEDS_WORKSPACE_SCOPE_MESSAGE);
      return ctx.queryLogs<TRow>(kql);
    },
  };
}
