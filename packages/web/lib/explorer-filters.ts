import type { Severity } from './types';
import type { ExplorerFinding, FindingDisplayStatus } from './explorer-data';

export type ExplorerStatusFilter = 'open' | 'new' | 'active' | 'fixed' | 'all';
export type ExplorerFilterDim = 'severity' | 'status' | 'subscription' | 'resourceGroup' | 'location' | 'tags';

/** Every dimension findings-explorer-client.tsx's `passesGlobalFilters` checks, pulled into a
 *  plain function (no React state closure) so it can be unit-tested directly and compared against
 *  the dashboard's own filtering (`queryActiveFindings` in dashboard-data.ts) instead of a
 *  hand-duplicated re-implementation of the same predicate. */
export interface ExplorerFilterState {
  showSuppressed: boolean;
  suppressedFingerprints: Set<string>;
  categories: Set<string>;
  severities: Set<Severity>;
  status: ExplorerStatusFilter;
  ruleIds: Set<string>;
  subscriptions: Set<string>;
  resourceGroups: Set<string>;
  locations: Set<string>;
  tags: Set<string>;
  search: string;
  rangeFrom: string;
  rangeTo: string;
}

// "New"/"Fixed" are defined purely by elapsed real time — never by comparing to "the previous
// scan" (see findings-explorer-client.tsx for the full rationale). `from`/`to` are date keys
// (YYYY-MM-DD), inclusive.
export function isWithinRange(iso: string | undefined, from: string, to: string): boolean {
  if (!iso) return false;
  const day = iso.slice(0, 10);
  return day >= from && day <= to;
}

export function getRecencyStatus(
  f: Pick<ExplorerFinding, 'status' | 'firstSeenAt'>,
  from: string,
  to: string,
): FindingDisplayStatus {
  if (f.status === 'fixed') return 'fixed';
  return isWithinRange(f.firstSeenAt, from, to) ? 'new' : 'active';
}

export function matchesExplorerFilters(
  f: ExplorerFinding,
  state: ExplorerFilterState,
  exclude?: Set<ExplorerFilterDim>,
): boolean {
  if (!state.showSuppressed && state.suppressedFingerprints.has(f.fingerprint)) return false;
  if (state.categories.size > 0 && !state.categories.has(f.category)) return false;
  if (!exclude?.has('severity') && state.severities.size > 0 && !state.severities.has(f.severity)) return false;
  if (!exclude?.has('status')) {
    const recency = getRecencyStatus(f, state.rangeFrom, state.rangeTo);
    if (state.status === 'open' && recency === 'fixed') return false;
    if (state.status === 'new' && recency !== 'new') return false;
    if (state.status === 'active' && recency !== 'active') return false;
    if (state.status === 'fixed' && recency !== 'fixed') return false;
  }
  if (state.ruleIds.size > 0 && !state.ruleIds.has(f.ruleId)) return false;
  if (!exclude?.has('subscription') && state.subscriptions.size > 0 && !state.subscriptions.has(f.subscriptionId)) return false;
  if (!exclude?.has('resourceGroup') && state.resourceGroups.size > 0 && !state.resourceGroups.has(f.resourceGroup ?? '')) return false;
  if (!exclude?.has('location') && state.locations.size > 0 && !state.locations.has(f.location ?? '')) return false;
  if (!exclude?.has('tags') && state.tags.size > 0 && !f.ruleTags.some(t => state.tags.has(t))) return false;
  if (state.search) {
    const q = state.search.toLowerCase();
    if (
      !(f.resourceName ?? '').toLowerCase().includes(q) &&
      !f.policyName.toLowerCase().includes(q) &&
      !(f.resourceType ?? '').toLowerCase().includes(q) &&
      !(f.resourceId ?? '').toLowerCase().includes(q)
    ) return false;
  }
  return true;
}
