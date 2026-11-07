/**
 * What a run covers (ADR 0011): the overlap of a rule's own scope and the access of whoever ran it.
 * A rule's scope says where it looks and the runner's access says where they may look; nobody sets the
 * overlap by hand. A run that covers less than Everything resolves findings only inside what it covered.
 *
 * Pure, no DB or Node imports, like `lib/written-query.ts` and `lib/rbac.ts`, so the scan runner, the
 * repositories and the Run History screen share one definition. A query a person writes is limited by
 * `lib/written-query.ts`; a shared rule is limited here, by its request: the rule's KQL is never
 * rewritten, only the subscriptions and management groups it is sent to.
 *
 * Only a Scope held at a Role that allows `scans:run` counts, asked through `can()`, never by comparing
 * a role name.
 */
import {
  EVERYTHING_SCOPE_PATH, EVERYTHING_TENANT_ID, accessReach, buildAccess, grantCovers, managementGroupIdOf, parseScope,
  type Access, type AccessReach, type ScopeGrant,
} from '@/lib/access-model';
import { OUTSIDE_ACCESS_LABEL } from '@/lib/outside-access';
import { expandManagementGroups, type HierarchyNode } from '@/lib/management-group-tree';
import { can, type Role } from '@/lib/rbac';
import type { FindingPlacement } from '@/lib/placement';

const ACTION = 'scans:run';
const MANAGEMENT_GROUP_PATH = '/providers/Microsoft.Management/managementGroups/';

// --- The Scope a run covered, as stored ---

/** One Scope a run covered, as stored on `schedule_runs` and `scans`: the grant's tenant id and its path. */
export interface CoveredEntry {
  tenantId: string;
  path: string;
}

/** What a run that covered Everything records. A row that records nothing (an earlier release) reads as this. */
export const EVERYTHING_COVERED: readonly CoveredEntry[] = Object.freeze([
  Object.freeze({ tenantId: EVERYTHING_TENANT_ID, path: EVERYTHING_SCOPE_PATH }),
]);

const entryKey = (e: CoveredEntry): string => `${e.tenantId}|${e.path.toLowerCase()}`;

/** The same Scopes in any order and any casing are the same key. */
export function coveredScopeKey(entries: readonly CoveredEntry[]): string {
  return [...new Set(entries.map(entryKey))].sort().join('\n');
}

export function sameCoveredScope(a: readonly CoveredEntry[], b: readonly CoveredEntry[]): boolean {
  return coveredScopeKey(a) === coveredScopeKey(b);
}

export function coversEverything(entries: readonly CoveredEntry[]): boolean {
  return entries.some(e => e.path === EVERYTHING_SCOPE_PATH);
}

/** What a person is told a run covered. `key` is opaque: equal for two runs that covered the same Scopes, and nothing else. */
export interface CoveredScopeView {
  key: string;
  entries: CoveredLabel[];
}

export interface CoveredLabel {
  /** The Scope as written, or `OUTSIDE_ACCESS_LABEL` for one the person's own access does not reach. */
  label: string;
  outside: boolean;
}

export const EVERYTHING_LABEL = 'Everything';

/** A run's covered Scope as an Everything reader reads Everything, for a run that is built and not stored (a test notification, a fixture). */
export const EVERYTHING_COVERED_VIEW: CoveredScopeView = Object.freeze({
  key: 'everything',
  entries: Object.freeze([{ label: EVERYTHING_LABEL, outside: false }]) as unknown as CoveredLabel[],
});
export const DIRECTORY_LABEL = 'Directory';

/**
 * The entries a person may read. Everything and the Directory are never names or ids, so they always
 * read as they are. A management group, subscription or resource group reads as its path only when the
 * person's own access reaches it (any Role): otherwise `OUTSIDE_ACCESS_LABEL`, because the id or name of
 * something they cannot see is not theirs to read. An Everything person reads every one.
 */
export function labelCoveredScope(entries: readonly CoveredEntry[], access: Access): CoveredLabel[] {
  return entries.map((entry): CoveredLabel => {
    const scope = parseScope(entry.path);
    if (scope?.kind === 'everything') return { label: EVERYTHING_LABEL, outside: false };
    if (scope?.kind === 'directory') return { label: DIRECTORY_LABEL, outside: false };
    if (access.everything) return { label: entry.path, outside: false };
    const reached = scope !== null && access.grants.some(g => grantCovers(access, g, scope));
    return reached ? { label: entry.path, outside: false } : { label: OUTSIDE_ACCESS_LABEL, outside: true };
  });
}

/** The usable grants of a runner: the Scopes they hold at a Role that allows running a scan. */
function usableGrants(access: Access): ScopeGrant[] {
  return access.grants.filter(g => can(g.role, ACTION));
}

/**
 * The Scope a person's run covers: Everything for someone who holds it at a Role that runs scans (an
 * Admin, the scheduler), and otherwise each Scope they hold at such a Role. A management group is one
 * entry, whatever sits under it now.
 */
export function coveredScopeOf(access: Access): CoveredEntry[] {
  const usable = usableGrants(access);
  if (usable.some(g => g.scope.kind === 'everything')) return [...EVERYTHING_COVERED];
  const seen = new Set<string>();
  const entries: CoveredEntry[] = [];
  for (const g of usable) {
    const entry = { tenantId: g.tenantId, path: g.scope.path };
    if (seen.has(entryKey(entry))) continue;
    seen.add(entryKey(entry));
    entries.push(entry);
  }
  return entries;
}

/**
 * The runner's access cut down to what a run covers: only the grants, and the management group
 * expansions, at a Role that allows `scans:run`. The same shape as the `Access` the reads take, so
 * `accessFilterSql()` can limit the resolve step to it and `placedInside()` can limit a scan's findings.
 */
export function coveredAccess(access: Access): Access {
  return buildAccess(usableGrants(access), access.source, access.managementGroups.filter(e => can(e.role, ACTION)));
}

// --- Which findings are inside it ---

/** Where a finding sits: the four fields `accessFilterSql()` reads. */
export interface PlacedFinding {
  placement?: FindingPlacement | string;
  subscriptionId?: string | null;
  resourceGroup?: string | null;
  managementGroupId?: string | null;
}

/**
 * Whether a finding sits inside what `reach` reaches. The in-memory twin of `accessFilterSql()`
 * (`lib/db/access-filter.ts`), derived from the same `accessReach()` and tested against it for every
 * placement, so a scan keeps exactly the findings the resolve step and the reads will see.
 */
export function placedInside(reach: AccessReach, f: PlacedFinding): boolean {
  if (reach.everything) return true;
  const subscription = (f.subscriptionId ?? '').toLowerCase();
  switch (f.placement) {
    case 'resource':
    case 'workspace': {
      if (reach.subscriptions.has(subscription)) return true;
      return reach.resourceGroups.get(subscription)?.has((f.resourceGroup ?? '').toLowerCase()) ?? false;
    }
    case 'subscription':
      return reach.subscriptions.has(subscription);
    case 'management-group':
      return reach.managementGroups.has((f.managementGroupId ?? '').toLowerCase());
    case 'directory':
      return reach.directory;
    default:
      return false;
  }
}

/** The test of "is this finding inside the covered Scope", with the reach worked out once. */
export function insideCovered(covered: Access): (f: PlacedFinding) => boolean {
  const reach = accessReach(covered);
  return f => placedInside(reach, f);
}

/** Microsoft Graph reads the directory, so its rules run only for a covered Scope that includes it. */
export function coversDirectory(covered: Access): boolean {
  return covered.everything || covered.directory;
}

/** Whether the covered Scope covers where the workspace sits. A workspace that could not be placed is not covered. */
export function coversWorkspace(covered: Access, placement: { subscriptionId: string; resourceGroup?: string } | null): boolean {
  if (covered.everything) return true;
  if (!placement || !placement.subscriptionId) return false;
  return placedInside(accessReach(covered), { placement: 'workspace', ...placement });
}

// --- The request a rule is sent with ---

/** The subscriptions and management groups a Resource Graph request names. Never empty: see `scopeForRule`. */
export interface RequestScope {
  subscriptions?: string[];
  managementGroups?: string[];
}

interface GroupExpansion {
  groups: Set<string>;
  subscriptions: Set<string>;
}

/** What a rule's own management group holds, from RuleBeat's copy of the tree, whichever tenant holds it. */
function expandRuleGroup(id: string, hierarchy: readonly HierarchyNode[]): GroupExpansion {
  const out: GroupExpansion = { groups: new Set(), subscriptions: new Set() };
  const grants: ScopeGrant[] = [...new Set(hierarchy.map(n => n.tenantId))].map(tenantId => ({
    tenantId, scope: { kind: 'managementGroup', path: `${MANAGEMENT_GROUP_PATH}${id}` }, role: 'viewer' as Role,
  }));
  for (const expansion of expandManagementGroups(grants, hierarchy)) {
    for (const g of expansion.groups) out.groups.add(g);
    for (const s of expansion.subscriptions) out.subscriptions.add(s);
  }
  return out;
}

/** Case-insensitive, first casing wins. */
class IdSet {
  private readonly ids = new Map<string, string>();
  add(id: string): void {
    const key = id.toLowerCase();
    if (!this.ids.has(key)) this.ids.set(key, id);
  }
  has(id: string): boolean { return this.ids.has(id.toLowerCase()); }
  values(): string[] { return [...this.ids.values()]; }
  get size(): number { return this.ids.size; }
}

/** What the covered Scope holds, with the casing it was granted in where it is known. */
function heldIds(covered: Access) {
  const directSubscriptions = new IdSet(); // whole subscriptions held as a subscription Scope
  const subscriptions = new IdSet();       // whole subscriptions: held, or under a held management group
  const groupSubscriptions = new IdSet();  // the subscriptions that hold a held resource group
  const managementGroups = new IdSet();    // held management group Scopes the tree knows
  for (const { scope } of covered.grants) {
    const parts = scope.path.split('/');
    if (scope.kind === 'subscription') { subscriptions.add(parts[2]!); directSubscriptions.add(parts[2]!); }
    else if (scope.kind === 'resourceGroup') groupSubscriptions.add(parts[2]!);
  }
  for (const expansion of covered.managementGroups) {
    if (expansion.groups.length === 0) continue;
    managementGroups.add(managementGroupIdOf(expansion.path));
    for (const id of expansion.subscriptions) subscriptions.add(id);
  }
  return { directSubscriptions, subscriptions, groupSubscriptions, managementGroups };
}

/**
 * The request a rule is sent with: the overlap of its own scope and the covered Scope, or null when they
 * share nothing and the rule is not run.
 *
 *  - Everything: the rule's own scope, untouched (an Admin's run and a scheduled run send what they always did).
 *  - A tenant-wide rule gets the runner's whole subscriptions and management groups, plus the subscriptions
 *    that hold their resource groups. Resource Graph cannot limit a request to a resource group, so the
 *    rows outside it are dropped from the findings afterwards (`insideCovered`).
 *  - A rule's subscription is kept when the runner holds it, or holds a resource group in it.
 *  - A rule's management group is kept when the runner holds it or one above it. Otherwise it is replaced by
 *    what the runner holds inside it: subscriptions, subscriptions holding a resource group, and
 *    management groups beneath it. `hierarchy` is RuleBeat's copy of the tree.
 *
 * Never an empty scope: Resource Graph's client reads one as every subscription the credential lists.
 */
export function scopeForRule(
  requested: RequestScope | undefined, covered: Access, hierarchy: readonly HierarchyNode[],
): RequestScope | undefined | null {
  if (covered.everything) return requested;

  const held = heldIds(covered);
  const reach = accessReach(covered);
  const subscriptions = new IdSet();
  const managementGroups = new IdSet();
  const askedSubscriptions = requested?.subscriptions?.filter(s => s.trim() !== '') ?? [];
  const askedGroups = requested?.managementGroups?.filter(g => g.trim() !== '') ?? [];

  if (askedSubscriptions.length === 0 && askedGroups.length === 0) {
    // A held management group is sent as itself, so only a subscription held by itself is listed beside it.
    for (const id of held.directSubscriptions.values()) subscriptions.add(id);
    for (const id of held.groupSubscriptions.values()) subscriptions.add(id);
    for (const id of held.managementGroups.values()) managementGroups.add(id);
  }

  for (const id of askedSubscriptions) {
    if (held.subscriptions.has(id) || held.groupSubscriptions.has(id)) subscriptions.add(id);
  }

  for (const id of askedGroups) {
    if (reach.managementGroups.has(id.toLowerCase())) {
      managementGroups.add(id);
      continue;
    }
    const inside = expandRuleGroup(id, hierarchy);
    // A held management group inside this one is added whole below, so only a subscription held by itself is listed.
    for (const sub of [...held.directSubscriptions.values(), ...held.groupSubscriptions.values()]) {
      if (inside.subscriptions.has(sub.toLowerCase())) subscriptions.add(sub);
    }
    for (const group of held.managementGroups.values()) {
      if (inside.groups.has(group.toLowerCase())) managementGroups.add(group);
    }
  }

  if (subscriptions.size === 0 && managementGroups.size === 0) return null;
  return {
    ...(subscriptions.size ? { subscriptions: subscriptions.values() } : {}),
    ...(managementGroups.size ? { managementGroups: managementGroups.values() } : {}),
  };
}

/**
 * The subscriptions a set of requests asked for: the ones named, and the ones under each management group
 * named, so `ScanSummary.subscriptionsScanned` lists what the run reached and not the whole tenant.
 */
export function subscriptionsAskedFor(scopes: readonly RequestScope[], hierarchy: readonly HierarchyNode[]): string[] {
  const asked = new IdSet();
  for (const scope of scopes) {
    for (const id of scope.subscriptions ?? []) asked.add(id);
    for (const group of scope.managementGroups ?? []) {
      const inside = expandRuleGroup(group, hierarchy);
      for (const node of hierarchy) {
        if (node.kind === 'subscription' && inside.subscriptions.has(node.id.toLowerCase())) asked.add(node.id);
      }
    }
  }
  return asked.values();
}
