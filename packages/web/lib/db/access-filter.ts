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
 *  - `management-group`: under Everything, or under a management group Scope on that group or one
 *    beneath it.
 *  - `unplaceable`: under Everything only.
 *  - Any other stored placement value: hidden.
 *
 * A management group Scope counts as a subscription Scope on every subscription under it, and as a
 * Scope on each group at or below it, by the expansion `Access` carries (read from the hierarchy cache
 * when the Access was resolved), so this stays synchronous. A group the cache does not hold under the
 * grant's tenant expands to nothing. Scopes add up. Subscription ids, group ids and resource group names
 * compare case-insensitively. A person who holds no usable Scope gets an explicit false: `or()` of
 * nothing is `undefined`, which `and()` would drop, and that would read as no filter at all.
 */
export function accessFilterSql(access: Access): SQL | undefined {
  if (access.everything) return undefined;
  const t = findingsTable;
  const subscriptions = new Set<string>();
  const managementGroups = new Set<string>();
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
  for (const expansion of access.managementGroups) {
    for (const id of expansion.subscriptions) subscriptions.add(id.toLowerCase());
    for (const id of expansion.groups) managementGroups.add(id.toLowerCase());
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
  if (managementGroups.size > 0) {
    conditions.push(and(eq(t.placement, 'management-group'), inArray(sql`lower(${t.managementGroupId})`, [...managementGroups]))!);
  }
  if (directory) conditions.push(eq(t.placement, 'directory'));
  return conditions.length === 0 ? sql`1 = 0` : or(...conditions)!;
}
