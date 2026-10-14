/**
 * The access model, as data. Pure, no DB or Node imports, so the server guard, the repositories and
 * client components share one definition, like `lib/rbac.ts` does for roles and actions.
 *
 * A person's access is a set of Roles, each held at a Scope (ADR 0010). A Scope is stored as its
 * Azure scope path and compared case-insensitively, but never lowercased in storage: the casing is
 * whatever Azure returned.
 */
import type { Role } from '@/lib/rbac';

/** The Roles a Scope can be granted at. An Admin is never scoped, so it is not one of them. */
export type GrantRole = 'viewer' | 'editor';

/** The Scope path of Everything: every finding on the install, whatever sits where. */
export const EVERYTHING_SCOPE_PATH = '/';

/**
 * The Scope path of the Directory. An ARM path always starts with `/`, so this can never collide
 * with one, and a path that does not start with `/` can only ever be this marker.
 */
export const DIRECTORY_SCOPE_PATH = '@directory';

/**
 * The tenant id stored on the Everything row. Everything covers the install, not one tenant, and
 * the upgrade cannot call Azure or assume a connection exists.
 */
export const EVERYTHING_TENANT_ID = '';

export type ScopeKind = 'everything' | 'directory' | 'managementGroup' | 'subscription' | 'resourceGroup';

export interface Scope {
  kind: ScopeKind;
  /** The path as stored, in its original casing. */
  path: string;
}

const MANAGEMENT_GROUP = /^\/providers\/microsoft\.management\/managementgroups\/[^/]+$/i;
const SUBSCRIPTION = /^\/subscriptions\/[^/]+$/i;
const RESOURCE_GROUP = /^\/subscriptions\/[^/]+\/resourcegroups\/[^/]+$/i;

/**
 * Reads a stored path into a Scope. Null for anything that is not one: a resource-level path (the
 * smallest Scope is a resource group), an empty or malformed path, a trailing slash.
 */
export function parseScope(path: unknown): Scope | null {
  if (typeof path !== 'string') return null;
  if (path === EVERYTHING_SCOPE_PATH) return { kind: 'everything', path };
  if (path.toLowerCase() === DIRECTORY_SCOPE_PATH) return { kind: 'directory', path };
  if (MANAGEMENT_GROUP.test(path)) return { kind: 'managementGroup', path };
  if (SUBSCRIPTION.test(path)) return { kind: 'subscription', path };
  if (RESOURCE_GROUP.test(path)) return { kind: 'resourceGroup', path };
  return null;
}

/** Two Scope paths are the same Scope when they differ only by case. */
export function sameScopePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export type AccessSource = 'manual' | 'mirrored';

export function isAccessSource(value: unknown): value is AccessSource {
  return value === 'manual' || value === 'mirrored';
}

export interface ScopeGrant {
  tenantId: string;
  scope: Scope;
  role: Role;
}

/** The id of the management group a management group path names: its last segment, as written. */
export function managementGroupIdOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * What one management group grant covers, read from RuleBeat's copy of the tree when the Access was
 * resolved (#273): the group itself and every subscription and group at or below it, in the grant's
 * tenant only. A group the tree does not hold under that tenant covers nothing. Ids are lowercase,
 * because they are only ever compared. The grant stays in `Access.grants` as stored; this is derived
 * from it and never written back.
 */
export interface ManagementGroupExpansion {
  tenantId: string;
  /** The grant's Scope path as stored. */
  path: string;
  role: Role;
  /** The group itself and every group beneath it. */
  groups: string[];
  /** Every subscription under any of those groups. */
  subscriptions: string[];
}

/**
 * What one person may do and where: the Role at each Scope, flags for the two Scopes the rest of
 * the product asks about first, and where the grants came from. `source` is null for an Admin, who
 * is never scoped and has no source.
 */
export interface Access {
  /** The rows as stored. A management group is one entry here, whatever sits under it. */
  grants: ScopeGrant[];
  /** What each management group grant covers now, derived from the hierarchy cache. */
  managementGroups: ManagementGroupExpansion[];
  everything: boolean;
  directory: boolean;
  source: AccessSource | null;
}

export function buildAccess(
  grants: ScopeGrant[],
  source: AccessSource | null,
  managementGroups: ManagementGroupExpansion[] = [],
): Access {
  return {
    grants,
    managementGroups,
    everything: grants.some(g => g.scope.kind === 'everything'),
    directory: grants.some(g => g.scope.kind === 'directory'),
    source,
  };
}

/**
 * Holds nothing. What a page reads under when nobody is signed in: never Everything. Frozen, so
 * one shared value cannot be widened by a caller.
 */
export const NO_ACCESS: Access = Object.freeze({
  grants: Object.freeze([]) as unknown as ScopeGrant[],
  managementGroups: Object.freeze([]) as unknown as ManagementGroupExpansion[],
  everything: false,
  directory: false,
  source: null,
});

/** The Role on Everything, with no source: an Admin's access, and the system's. */
export function everythingAccess(role: Role, source: AccessSource | null = null): Access {
  return buildAccess(
    [{ tenantId: EVERYTHING_TENANT_ID, scope: { kind: 'everything', path: EVERYTHING_SCOPE_PATH }, role }],
    source,
  );
}

/**
 * Whether a grant's Scope contains a placement, from the Scope alone. Everything contains all of them. A
 * management group contains only itself here: what sits under it is in the hierarchy cache, which a bare
 * Scope does not carry. `grantCovers` is the one that reads it.
 */
export function scopeCovers(grant: Scope, placement: Scope): boolean {
  if (grant.kind === 'everything') return true;
  const g = grant.path.toLowerCase();
  const p = placement.path.toLowerCase();
  if (g === p) return true;
  return grant.kind === 'subscription' && placement.kind === 'resourceGroup' && p.startsWith(`${g}/`);
}

/**
 * Whether one grant's Scope contains a placement, a management group grant included: it covers a
 * subscription or a resource group in a subscription under it, and itself and any group beneath it, by
 * the expansion `access` carries. A management group grant with no expansion covers nothing: it fails closed.
 */
export function grantCovers(access: Pick<Access, 'managementGroups'>, grant: ScopeGrant, placement: Scope): boolean {
  if (grant.scope.kind !== 'managementGroup') return scopeCovers(grant.scope, placement);
  const expansion = access.managementGroups.find(e =>
    e.tenantId === grant.tenantId && e.role === grant.role && sameScopePath(e.path, grant.scope.path));
  if (!expansion) return false;
  const parts = placement.path.toLowerCase().split('/');
  if (placement.kind === 'subscription' || placement.kind === 'resourceGroup') return expansion.subscriptions.includes(parts[2]!);
  if (placement.kind === 'managementGroup') return expansion.groups.includes(parts[parts.length - 1]!);
  return false;
}

/** One Scope an Admin hands someone, as the request carries it: a path and a Role, no tenant id. */
export interface ManualGrant {
  scope: string;
  role: GrantRole;
}

/** The most that can be handed out in one save. A person holds a few Scopes; this keeps one request bounded. */
export const MAX_MANUAL_GRANTS = 200;

/** The highest Role among some grants: an Editor if any is, else a Viewer, which is also what holding none reads as. */
export function highestRole(grants: readonly { role: Role }[]): GrantRole {
  return grants.some(g => g.role === 'editor') ? 'editor' : 'viewer';
}

/** A Scope listed twice, in any casing, is held once, at the higher Role. The first casing wins. */
export function collapseGrants<T extends { scope: string; role: Role }>(grants: readonly T[]): T[] {
  const byPath = new Map<string, T>();
  for (const grant of grants) {
    const key = grant.scope.toLowerCase();
    const held = byPath.get(key);
    if (!held) byPath.set(key, grant);
    else if (grant.role === 'editor' && held.role !== 'editor') byPath.set(key, { ...held, role: grant.role });
  }
  return [...byPath.values()];
}

export type ManualAccessResult = { ok: true; grants: ManualGrant[] } | { ok: false; error: string };

/**
 * Reads the list of Scopes an Admin chose, or says why it cannot be stored. The messages are what the
 * route returns, so they are stable and name no path. Whether a management group is one RuleBeat's copy
 * of the tree holds is not decided here: it needs the database, so `assignmentsFor` does.
 */
export function parseManualAccess(input: unknown): ManualAccessResult {
  if (!Array.isArray(input)) return { ok: false, error: 'Access must be a list of scopes.' };
  if (input.length > MAX_MANUAL_GRANTS) return { ok: false, error: `Give at most ${MAX_MANUAL_GRANTS} scopes at a time.` };
  const grants: ManualGrant[] = [];
  for (const item of input) {
    const entry = (typeof item === 'object' && item !== null ? item : {}) as { scope?: unknown; role?: unknown };
    if (typeof entry.scope !== 'string' || typeof entry.role !== 'string') {
      return { ok: false, error: 'Each scope needs a path and a Role.' };
    }
    if (entry.role === 'admin') return { ok: false, error: 'The Admin Role cannot be given at a scope.' };
    if (entry.role !== 'viewer' && entry.role !== 'editor') return { ok: false, error: 'Choose Viewer or Editor for each scope.' };
    const scope = parseScope(entry.scope);
    if (!scope) return { ok: false, error: 'A scope must be Everything, the Directory, a management group, a subscription or a resource group.' };
    grants.push({ scope: entry.scope, role: entry.role });
  }
  return { ok: true, grants: collapseGrants(grants) };
}

/** Whether a person holds no Scope at all, so every read of findings is empty for them. */
export function holdsNoScope(access: Access): boolean {
  return access.grants.length === 0;
}

/**
 * The subscriptions a person holds whole, lowercase and without repeats: a subscription Scope, and every
 * subscription under a management group Scope by the expansion `access` carries. A resource group Scope
 * holds part of a subscription, so it is not one. Everything holds every subscription, which a list cannot
 * name, so callers ask `access.everything` first.
 */
export function wholeSubscriptionIds(access: Pick<Access, 'grants' | 'managementGroups'>): string[] {
  const ids = new Set<string>();
  for (const { scope } of access.grants) {
    if (scope.kind === 'subscription') ids.add(scope.path.split('/')[2]!.toLowerCase());
  }
  for (const expansion of access.managementGroups) {
    for (const id of expansion.subscriptions) ids.add(id.toLowerCase());
  }
  return [...ids];
}

/**
 * Everything an `Access` reaches, in the shape both readers of it need: the SQL condition
 * (`lib/db/access-filter.ts`) and the in-memory test of a finding a scan has just read
 * (`lib/run-scope.ts`). One derivation, so the two cannot disagree. Ids and names are lowercase.
 *
 *  - `subscriptions`: whole subscriptions, held directly or under a management group Scope.
 *  - `resourceGroups`: resource group names by their subscription.
 *  - `managementGroups`: every management group at or below a management group Scope, by the expansion.
 */
export interface AccessReach {
  everything: boolean;
  directory: boolean;
  subscriptions: Set<string>;
  resourceGroups: Map<string, Set<string>>;
  managementGroups: Set<string>;
}

export function accessReach(access: Pick<Access, 'grants' | 'managementGroups' | 'everything' | 'directory'>): AccessReach {
  const subscriptions = new Set<string>();
  const managementGroups = new Set<string>();
  const resourceGroups = new Map<string, Set<string>>();
  for (const { scope } of access.grants) {
    const parts = scope.path.split('/');
    if (scope.kind === 'subscription') subscriptions.add(parts[2]!.toLowerCase());
    else if (scope.kind === 'resourceGroup') {
      const sub = parts[2]!.toLowerCase();
      const groups = resourceGroups.get(sub) ?? new Set<string>();
      groups.add(parts[4]!.toLowerCase());
      resourceGroups.set(sub, groups);
    }
  }
  for (const expansion of access.managementGroups) {
    for (const id of expansion.subscriptions) subscriptions.add(id.toLowerCase());
    for (const id of expansion.groups) managementGroups.add(id.toLowerCase());
  }
  return { everything: access.everything, directory: access.directory, subscriptions, resourceGroups, managementGroups };
}

/** The text the Access page shows for one person's access. */
export function describeAccess(access: Access): string {
  const sourceSuffix = access.source ? `, ${access.source}` : '';
  if (access.everything) return `Everything${sourceSuffix}`;
  if (access.grants.length === 0) return `No access${sourceSuffix}`;
  const n = access.grants.length;
  return `${n} ${n === 1 ? 'scope' : 'scopes'}${sourceSuffix}`;
}
