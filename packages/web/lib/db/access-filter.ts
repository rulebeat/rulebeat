import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { findings as findingsTable, scanFindings } from './tables';
import { accessReach, type Access } from '../access-model';

/** The two tables that hold where a finding sits: the live `findings` and a scan's `scan_findings` records. */
export type PlacedTable = typeof findingsTable | typeof scanFindings;

/**
 * The condition a person's access puts on the `findings` table (or on a scan's `scan_findings` records,
 * which hold the same four placement columns), or undefined when it puts none
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
export function accessFilterSql(access: Access, t: PlacedTable = findingsTable): SQL | undefined {
  if (access.everything) return undefined;
  const { subscriptions, managementGroups, resourceGroups, directory } = accessReach(access);

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
