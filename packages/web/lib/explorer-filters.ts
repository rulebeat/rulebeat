import type { Severity } from './types';
import type { ExplorerFinding, FindingDisplayStatus } from './explorer-data';

/** 'open' is every finding open right now; 'new' and 'fixed' are both bounded by the chosen
 *  window, the same way the New and Fixed header tiles count; 'all' is the two together. */
export type ExplorerStatusFilter = 'open' | 'new' | 'fixed' | 'all';
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

/** Fixed, and fixed inside the window. What the Fixed tile, the Fixed column and the Fixed status
 *  option all count, so the three can never disagree. */
export function isFixedInWindow(
  f: Pick<ExplorerFinding, 'status' | 'resolvedAt'>,
  from: string,
  to: string,
): boolean {
  return f.status === 'fixed' && isWithinRange(f.resolvedAt, from, to);
}

/** A `?status=` value read back from the URL. 'active' was the old "ongoing only" option and is
 *  read as 'open', so a link saved before it was removed still opens. */
export function parseExplorerStatus(value: string | undefined): ExplorerStatusFilter {
  return value === 'new' || value === 'fixed' || value === 'all' ? value : 'open';
}

export interface RuleCounts {
  /** Open right now, whatever the window. */
  open: number;
  /** Open and first seen inside the window. A subset of `open`. */
  new: number;
  /** Fixed inside the window. */
  fixed: number;
}

/** Per-rule Open/New/Fixed for the by-rule view. Pass it a pool that has every filter applied
 *  except status: the status filter picks which rules are listed, not what their counts say. */
export function countFindingsByRule(
  findings: ExplorerFinding[],
  from: string,
  to: string,
): Map<string, RuleCounts> {
  const counts = new Map<string, RuleCounts>();
  for (const f of findings) {
    let c = counts.get(f.ruleId);
    if (!c) { c = { open: 0, new: 0, fixed: 0 }; counts.set(f.ruleId, c); }
    const recency = getRecencyStatus(f, from, to);
    if (recency !== 'fixed') c.open++;
    if (recency === 'new') c.new++;
    if (isFixedInWindow(f, from, to)) c.fixed++;
  }
  return counts;
}

/** The findings a filter dropdown (subscription, resource group, location, tags) counts its
 *  options from: every filter applied except that dropdown's own, so its counts match the table
 *  and picking one value never hides the others. */
export function facetPool(
  findings: ExplorerFinding[],
  state: ExplorerFilterState,
  dim: Exclude<ExplorerFilterDim, 'severity' | 'status'>,
): ExplorerFinding[] {
  const exclude = new Set<ExplorerFilterDim>([dim]);
  return findings.filter(f => matchesExplorerFilters(f, state, exclude));
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
    if ((state.status === 'fixed' || state.status === 'all') && recency === 'fixed'
      && !isFixedInWindow(f, state.rangeFrom, state.rangeTo)) return false;
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
