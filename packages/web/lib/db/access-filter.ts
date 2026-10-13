import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { findings as findingsTable } from './tables';
import type { Access } from '../access-model';

/**
 * The condition a person's access puts on the `findings` table, or undefined when it puts none
 * (Everything). A finding is seen when its placement sits inside a Scope the person holds:
 *
 *  - `resource` and `workspace`: under a subscription Scope on its subscription, or a resource group
 *    Scope matching both its subscription and its resource group.
 *  - `subscription`: under a subscription Scope on that subscription only. A resource group Scope
 *    inside it does not see it.
 *  - `directory`: under the Directory Scope only.
 *  - `management-group` and `unplaceable`: under Everything only. A management group Scope covers
 *    nothing until the hierarchy cache exists (#273), so it adds no condition.
 *  - Any other stored placement value: hidden.
 *
 * Scopes add up. Subscription ids and resource group names compare case-insensitively. A person who
 * holds no usable Scope gets an explicit false: `or()` of nothing is `undefined`, which `and()` would
 * drop, and that would read as no filter at all.
 */
export function accessFilterSql(access: Access): SQL | undefined {
  if (access.everything) return undefined;
  const t = findingsTable;
  const subscriptions = new Set<string>();
  const resourceGroups = new Map<string, Set<string>>();
  let directory = false;
  for (const { scope } of access.grants) {
    const parts = scope.path.split('/');
    if (scope.kind === 'subscription') subscriptions.add(parts[2]!.toLowerCase());
    else if (scope.kind === 'resourceGroup') {
      const sub = parts[2]!.toLowerCase();
      const groups = resourceGroups.get(sub) ?? new Set<string>();
      groups.add(parts[4]!.toLowerCase());
      resourceGroups.set(sub, groups);
    } else if (scope.kind === 'directory') directory = true;
  }

  const lowerSubscription = sql`lower(${t.subscriptionId})`;
  const lowerGroup = sql`lower(${t.resourceGroup})`;
  const conditions: SQL[] = [];
  if (subscriptions.size > 0) {
    conditions.push(and(inArray(t.placement, ['resource', 'workspace', 'subscription']), inArray(lowerSubscription, [...subscriptions]))!);
  }
  for (const [sub, groups] of resourceGroups) {
    if (subscriptions.has(sub)) continue;
    conditions.push(and(inArray(t.placement, ['resource', 'workspace']), eq(lowerSubscription, sub), inArray(lowerGroup, [...groups]))!);
  }
  if (directory) conditions.push(eq(t.placement, 'directory'));
  return conditions.length === 0 ? sql`1 = 0` : or(...conditions)!;
}
