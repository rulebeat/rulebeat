/**
 * The access model, as data. Pure, no DB or Node imports, so the server guard, the repositories and
 * client components share one definition, like `lib/rbac.ts` does for roles and actions.
 *
 * A person's access is a set of Roles, each held at a Scope (ADR 0010). A Scope is stored as its
 * Azure scope path and compared case-insensitively, but never lowercased in storage: the casing is
 * whatever Azure returned.
 */
import type { Role } from '@/lib/rbac';

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

/**
 * What one person may do and where: the Role at each Scope, flags for the two Scopes the rest of
 * the product asks about first, and where the grants came from. `source` is null for an Admin, who
 * is never scoped and has no source.
 */
export interface Access {
  grants: ScopeGrant[];
  everything: boolean;
  directory: boolean;
  source: AccessSource | null;
}

export function buildAccess(grants: ScopeGrant[], source: AccessSource | null): Access {
  return {
    grants,
    everything: grants.some(g => g.scope.kind === 'everything'),
    directory: grants.some(g => g.scope.kind === 'directory'),
    source,
  };
}

/** The Role on Everything, with no source: an Admin's access, and the system's. */
export function everythingAccess(role: Role, source: AccessSource | null = null): Access {
  return buildAccess(
    [{ tenantId: EVERYTHING_TENANT_ID, scope: { kind: 'everything', path: EVERYTHING_SCOPE_PATH }, role }],
    source,
  );
}

/**
 * Whether a grant's Scope contains a placement. Everything contains all of them. A management
 * group contains only itself here: expanding it to what sits under it needs the hierarchy cache.
 */
export function scopeCovers(grant: Scope, placement: Scope): boolean {
  if (grant.kind === 'everything') return true;
  const g = grant.path.toLowerCase();
  const p = placement.path.toLowerCase();
  if (g === p) return true;
  return grant.kind === 'subscription' && placement.kind === 'resourceGroup' && p.startsWith(`${g}/`);
}

/** The text the Access page shows for one person's access. */
export function describeAccess(access: Access): string {
  const sourceSuffix = access.source ? `, ${access.source}` : '';
  if (access.everything) return `Everything${sourceSuffix}`;
  if (access.grants.length === 0) return `No access${sourceSuffix}`;
  const n = access.grants.length;
  return `${n} ${n === 1 ? 'scope' : 'scopes'}${sourceSuffix}`;
}
