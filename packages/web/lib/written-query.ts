/**
 * What a query a person writes may reach (ADR 0011). The Query page and the rule editor's three
 * previews send a query the person wrote, so it is limited by its request, never by filtering its
 * rows and never by rewriting its KQL: Resource Graph gets only the subscriptions and management
 * groups the person holds, Microsoft Graph needs the Directory, and Log Analytics needs a Scope
 * covering the workspace's resource group.
 *
 * Pure, no DB or Node imports, like `lib/rbac.ts`, so the routes and the Query page share one
 * definition. It sits above `createTenantContext`, whose limit is only the floor: what the person holds at any Role.
 *
 * Only a Scope held at a Role that allows the action counts, asked through `can()` and `mayAct()`,
 * never by comparing a role name.
 */
import { DIRECTORY_SCOPE_PATH, parseScope, type Access, type Scope } from '@/lib/access-model';
import { can, mayAct } from '@/lib/rbac';

const ACTION = 'rules:validate';

/** A person whose access is only resource groups, or who holds nothing usable, writes no query. */
export const NEEDS_SUBSCRIPTION_MESSAGE =
  'Writing a query needs access to a subscription or a management group, and yours does not include one. '
  + 'Resource Graph cannot limit a query to a resource group, so ask an Admin to give you a subscription.';

export const NO_HELD_SCOPE_REQUESTED_MESSAGE =
  'None of the subscriptions or management groups in this request are ones you have access to. '
  + 'Choose from your own, or leave the scope empty to use all of them.';

export const NEEDS_DIRECTORY_MESSAGE =
  'Querying Microsoft Graph needs access to the Directory, and yours does not include it. '
  + 'Ask an Admin to give you the Directory.';

export const NEEDS_WORKSPACE_SCOPE_MESSAGE =
  'Your access does not cover the resource group of the Log Analytics workspace, or the workspace could not be found. '
  + 'Ask an Admin to give you its subscription or resource group.';

export type Decision<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** The subscriptions and management groups a request may name, in the shape Resource Graph takes. */
export interface HeldQueryScopes {
  subscriptions: string[];
  managementGroups: string[];
}

function holdsEverything(access: Access): boolean {
  return access.grants.some(g => g.scope.kind === 'everything' && can(g.role, ACTION));
}

function usableGrants(access: Access) {
  return access.grants.filter(g => can(g.role, ACTION));
}

/** The id of a subscription Scope, or the name of a management group Scope, in the casing it was stored with. */
function lastSegment(scope: Scope): string {
  return scope.path.split('/').pop() ?? '';
}

/**
 * The subscriptions and management groups this person holds at a Role that allows writing a query.
 * Empty for Everything: nothing is held one by one, and nothing is limited.
 */
export function heldQueryScopes(access: Access): HeldQueryScopes {
  const subscriptions = new Map<string, string>();
  const managementGroups = new Map<string, string>();
  for (const { scope } of usableGrants(access)) {
    const id = lastSegment(scope);
    const key = id.toLowerCase();
    if (scope.kind === 'subscription' && !subscriptions.has(key)) subscriptions.set(key, id);
    else if (scope.kind === 'managementGroup' && !managementGroups.has(key)) managementGroups.set(key, id);
  }
  return { subscriptions: [...subscriptions.values()], managementGroups: [...managementGroups.values()] };
}

/**
 * What the Scope control on the Query page offers: null for Everything, which picks from the whole
 * tenant, and otherwise exactly what the person holds.
 */
export function queryScopeLimit(access: Access): HeldQueryScopes | null {
  return holdsEverything(access) ? null : heldQueryScopes(access);
}

/**
 * Whether this person writes no queries at all: they do not hold Everything and no usable Scope is
 * anything but a resource group. The Query page shows its unavailable state, and every route that
 * runs a written query refuses.
 */
export function writesNoQueries(access: Access): boolean {
  if (holdsEverything(access)) return false;
  return !usableGrants(access).some(g => g.scope.kind !== 'resourceGroup');
}

/** The refusal every written-query route gives first, or ok. */
export function mayWriteQueries(access: Access): Decision {
  return writesNoQueries(access) ? { ok: false, error: NEEDS_SUBSCRIPTION_MESSAGE } : { ok: true };
}

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [];

/**
 * The scope a Resource Graph query is sent with. `requested` is what the request body carried,
 * untrusted: it is handed back untouched for Everything (an absent one stays absent), and for anyone
 * else it is read only for the subscriptions and management groups it names.
 *
 *  - No request, or one that names none: everything the person holds.
 *  - A request: only the entries that equal a held one, ignoring case, sent in the held casing.
 *  - Nothing left: refused. An empty scope is never returned, since Resource Graph's client reads
 *    an empty scope as every subscription the credential lists.
 */
export function resourceGraphScope<T>(access: Access, requested: T | undefined): Decision<{ scope: T | HeldQueryScopesRequest | undefined }> {
  if (holdsEverything(access)) return { ok: true, scope: requested };
  const refused = mayWriteQueries(access);
  if (!refused.ok) return refused;

  const held = heldQueryScopes(access);
  if (held.subscriptions.length === 0 && held.managementGroups.length === 0) {
    return { ok: false, error: NEEDS_SUBSCRIPTION_MESSAGE };
  }

  const asked = typeof requested === 'object' && requested !== null ? requested as Record<string, unknown> : {};
  const askedSubscriptions = stringsOf(asked['subscriptions']).map(s => s.toLowerCase());
  const askedManagementGroups = stringsOf(asked['managementGroups']).map(s => s.toLowerCase());
  if (askedSubscriptions.length === 0 && askedManagementGroups.length === 0) return { ok: true, scope: toRequest(held) };

  const subscriptions = held.subscriptions.filter(id => askedSubscriptions.includes(id.toLowerCase()));
  const managementGroups = held.managementGroups.filter(id => askedManagementGroups.includes(id.toLowerCase()));
  if (subscriptions.length === 0 && managementGroups.length === 0) {
    return { ok: false, error: NO_HELD_SCOPE_REQUESTED_MESSAGE };
  }
  return { ok: true, scope: toRequest({ subscriptions, managementGroups }) };
}

export interface HeldQueryScopesRequest {
  subscriptions?: string[];
  managementGroups?: string[];
}

function toRequest(scopes: HeldQueryScopes): HeldQueryScopesRequest {
  return {
    ...(scopes.subscriptions.length ? { subscriptions: scopes.subscriptions } : {}),
    ...(scopes.managementGroups.length ? { managementGroups: scopes.managementGroups } : {}),
  };
}

/** Microsoft Graph reads the directory, so a query on it needs the Directory Scope (or Everything). */
export function mayQueryDirectory(access: Access): Decision {
  const directory = parseScope(DIRECTORY_SCOPE_PATH)!;
  if (writesNoQueries(access)) return { ok: false, error: NEEDS_SUBSCRIPTION_MESSAGE };
  return mayAct(access, ACTION, directory) ? { ok: true } : { ok: false, error: NEEDS_DIRECTORY_MESSAGE };
}

/** Whether a Log Analytics query needs the workspace looked up first: anyone without Everything. */
export function needsWorkspaceLookup(access: Access): boolean {
  return !holdsEverything(access);
}

/**
 * Whether a held Scope covers where the workspace sits. A workspace that could not be placed is
 * refused, since nothing says what it sits inside.
 */
export function mayQueryWorkspace(
  access: Access, placement: { subscriptionId: string; resourceGroup?: string } | null,
): Decision {
  if (holdsEverything(access)) return { ok: true };
  if (writesNoQueries(access)) return { ok: false, error: NEEDS_SUBSCRIPTION_MESSAGE };
  if (!placement || !placement.subscriptionId) return { ok: false, error: NEEDS_WORKSPACE_SCOPE_MESSAGE };
  const path = placement.resourceGroup
    ? `/subscriptions/${placement.subscriptionId}/resourceGroups/${placement.resourceGroup}`
    : `/subscriptions/${placement.subscriptionId}`;
  const scope = parseScope(path);
  if (!scope || !mayAct(access, ACTION, scope)) return { ok: false, error: NEEDS_WORKSPACE_SCOPE_MESSAGE };
  return { ok: true };
}
