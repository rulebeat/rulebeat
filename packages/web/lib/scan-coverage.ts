/**
 * Which finished scan covers a Scope (#402). The one definition the Rules tab's Outcome and live posture
 * share, so a rule is never passing in one place because a scan that never looked there is counted as
 * having looked. Pure, no DB or Node imports, like `lib/run-scope.ts`, so it is tested without a database.
 *
 *  - A subscription or a resource group is covered by a scan whose `subscriptionsScanned` holds the
 *    subscription.
 *  - A management group is covered by a scan whose covered Scope is at or under it, or whose
 *    `subscriptionsScanned` holds a subscription under it, by RuleBeat's copy of the management group tree.
 *  - The Directory is covered by a scan whose covered Scope includes it (`coversDirectory`).
 *  - Everything is covered by any finished scan.
 *
 * A reader below Everything passes scans whose `subscriptionsScanned` is already cut to what they hold, so
 * a subscription outside their access is never covered for them.
 */
import { buildAccess, managementGroupIdOf, parseScope, type Scope, type ScopeGrant } from '@/lib/access-model';
import type { HierarchyNode } from '@/lib/management-group-tree';
import { coversDirectory, expandRuleGroup, type CoveredEntry } from '@/lib/run-scope';

/** What covering reads off a finished scan. */
export interface CoverageScan {
  finishedAt: string;
  /** The subscriptions the scan reached, already cut to what the reader holds. */
  subscriptionsScanned: readonly string[];
  /** The Scope the run covered; a null stored value is Everything (`parseCoveredScope`). */
  coveredScope: readonly CoveredEntry[];
}

const subscriptionOf = (scope: Scope): string => scope.path.split('/')[2]!.toLowerCase();

/** The covered Scope as an Access, so the Directory question is asked of the existing check and not re-derived. */
function coveredAsAccess(entries: readonly CoveredEntry[]) {
  const grants = entries.flatMap((e): ScopeGrant[] => {
    const parsed = parseScope(e.path);
    return parsed ? [{ tenantId: e.tenantId, scope: parsed, role: 'editor' }] : [];
  });
  return buildAccess(grants, null);
}

export function scanCovers(scan: CoverageScan, scope: Scope, hierarchy: readonly HierarchyNode[]): boolean {
  switch (scope.kind) {
    case 'everything':
      return true;
    case 'directory':
      return coversDirectory(coveredAsAccess(scan.coveredScope));
    case 'subscription':
    case 'resourceGroup': {
      const wanted = subscriptionOf(scope);
      return scan.subscriptionsScanned.some(id => id.toLowerCase() === wanted);
    }
    case 'managementGroup': {
      const inside = expandRuleGroup(managementGroupIdOf(scope.path), hierarchy);
      const coveredInside = scan.coveredScope.some(entry => {
        const covered = parseScope(entry.path);
        if (!covered) return false;
        if (covered.kind === 'managementGroup') return inside.groups.has(managementGroupIdOf(covered.path).toLowerCase());
        if (covered.kind === 'subscription' || covered.kind === 'resourceGroup') return inside.subscriptions.has(subscriptionOf(covered));
        return false;
      });
      return coveredInside || scan.subscriptionsScanned.some(id => inside.subscriptions.has(id.toLowerCase()));
    }
  }
}

/** The newest of `scans` that covers the Scope, or undefined when none does. `scans` may come in any order. */
export function newestCoveringScan<T extends CoverageScan>(
  scans: readonly T[], scope: Scope, hierarchy: readonly HierarchyNode[],
): T | undefined {
  let newest: T | undefined;
  for (const scan of scans) {
    if (!scanCovers(scan, scope, hierarchy)) continue;
    if (!newest || scan.finishedAt > newest.finishedAt) newest = scan;
  }
  return newest;
}
