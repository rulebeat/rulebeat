/**
 * Mirrored access, as data (#278). Pure, no DB or Node imports, so the mirror, the repositories, the routes
 * and the Access page share one definition, like `lib/access-model.ts` does for Scopes.
 *
 * A mirror turns the Azure role assignments of a Linked account into Scopes. Which Azure role gave a Scope,
 * and whether it came through a group or is only PIM-eligible, is kept beside the Scope as its origins so the
 * Access page can explain it. The Azure role never decides the RuleBeat Role.
 */
import { parseScope } from '@/lib/access-model';

/** Why one Scope is held: the Azure role, and how the Linked account came to hold it. */
export interface ScopeOrigin {
  /** The display name of the Azure role. */
  roleName: string;
  /** Held through a group the Linked account belongs to, when the response says so. */
  throughGroup: boolean;
  /** PIM-eligible rather than active. */
  eligible: boolean;
}

/** A Scope the mirror gives, with every origin that gave it. */
export interface MirroredScope {
  /** The Scope path, in the casing Azure returned. */
  scope: string;
  origins: ScopeOrigin[];
}

/** One role assignment as Azure answered it, active or PIM-eligible. */
export interface ReadAssignment {
  scope: string;
  roleDefinitionId: string;
  principalType: string | null;
  memberType: string | null;
}

/** One role assignment with its role named, ready to become a Scope. */
export interface NamedAssignment {
  scope: string;
  roleName: string;
  eligible: boolean;
  principalType: string | null;
  memberType: string | null;
}

const RESOURCE_GROUP_PREFIX = /^(\/subscriptions\/[^/]+\/resourcegroups\/[^/]+)\/.+/i;

/**
 * The Scope an Azure scope path gives, or null when it gives none. A management group, a subscription and a
 * resource group are Scopes as they are. A path inside a resource group (a single resource) gives that
 * resource group, with the casing Azure used. Anything else gives nothing: the root path `/`, a subscription
 * level resource, a path that is not Azure's. A mirror never gives Everything or the Directory, so those two
 * can never come out of here whatever Azure says.
 */
export function scopeOfAzurePath(path: string): string | null {
  const trimmed = path.trim().replace(/\/+$/, '');
  const scope = parseScope(trimmed);
  if (scope) return scope.kind === 'everything' || scope.kind === 'directory' ? null : trimmed;
  const inside = RESOURCE_GROUP_PREFIX.exec(trimmed);
  return inside ? inside[1]! : null;
}

/** Whether Azure says a role is held through a group: a group principal on an active assignment, or a `Group` member of an eligibility. */
export function isThroughGroup(a: Pick<NamedAssignment, 'principalType' | 'memberType'>): boolean {
  return a.principalType === 'Group' || a.principalType === 'ForeignGroup' || a.memberType === 'Group';
}

const sameOrigin = (a: ScopeOrigin, b: ScopeOrigin): boolean =>
  a.roleName.toLowerCase() === b.roleName.toLowerCase() && a.throughGroup === b.throughGroup && a.eligible === b.eligible;

function compareOrigins(a: ScopeOrigin, b: ScopeOrigin): number {
  return a.roleName.localeCompare(b.roleName)
    || Number(a.eligible) - Number(b.eligible)
    || Number(a.throughGroup) - Number(b.throughGroup);
}

/**
 * Assignments in, Scopes with their origins out. Each Scope is held once, whatever number of assignments
 * give it and in whatever casing, and carries each distinct origin once. The first casing seen is the one
 * kept. Sorted by path so a refresh that changes nothing gives an identical list.
 */
export function scopesFromAssignments(assignments: readonly NamedAssignment[]): MirroredScope[] {
  const byPath = new Map<string, MirroredScope>();
  for (const assignment of assignments) {
    const scope = scopeOfAzurePath(assignment.scope);
    if (!scope) continue;
    const origin: ScopeOrigin = {
      roleName: assignment.roleName,
      throughGroup: isThroughGroup(assignment),
      eligible: assignment.eligible,
    };
    const key = scope.toLowerCase();
    const held = byPath.get(key);
    if (!held) byPath.set(key, { scope, origins: [origin] });
    else if (!held.origins.some(o => sameOrigin(o, origin))) held.origins.push(origin);
  }
  return [...byPath.values()]
    .map(s => ({ ...s, origins: [...s.origins].sort(compareOrigins) }))
    .sort((a, b) => a.scope.toLowerCase().localeCompare(b.scope.toLowerCase()));
}

/** Reads the origins stored beside a Scope. Anything that is not the shape written reads as no origin. */
export function parseOrigins(raw: string | null | undefined): ScopeOrigin[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const origins: ScopeOrigin[] = [];
    for (const item of parsed) {
      const entry = (typeof item === 'object' && item !== null ? item : {}) as Partial<ScopeOrigin>;
      if (typeof entry.roleName !== 'string') continue;
      origins.push({ roleName: entry.roleName, throughGroup: entry.throughGroup === true, eligible: entry.eligible === true });
    }
    return origins;
  } catch {
    return [];
  }
}

/** What is stored beside a Scope: null for none, so a manual row never holds a value. */
export function serializeOrigins(origins: readonly ScopeOrigin[] | undefined): string | null {
  return origins && origins.length > 0 ? JSON.stringify(origins) : null;
}

/** How the Access page names one origin: the Azure role, and "through a group" or "eligible" where it applies. */
export function describeOrigin(origin: ScopeOrigin): string {
  const how = [origin.throughGroup ? 'through a group' : null, origin.eligible ? 'eligible' : null].filter(Boolean);
  return how.length > 0 ? `${origin.roleName} (${how.join(', ')})` : origin.roleName;
}

/** All the origins of one Scope as one line. */
export function describeOrigins(origins: readonly ScopeOrigin[]): string {
  return origins.map(describeOrigin).join(', ');
}

const OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An Azure object id as stored and compared: a GUID, lowercase. Null for anything else. */
export function parseObjectId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  return OBJECT_ID.test(trimmed) ? trimmed.toLowerCase() : null;
}

/** Why a refresh failed, as a code to branch on. The code is what is stored; the message is derived from it. */
export type MirrorErrorCode = 'azure_not_configured' | 'throttled' | 'failed';

export function isMirrorErrorCode(value: unknown): value is MirrorErrorCode {
  return value === 'azure_not_configured' || value === 'throttled' || value === 'failed';
}

export interface MirrorError {
  code: MirrorErrorCode;
  message: string;
}

export const MIRROR_NOT_CONNECTED_MESSAGE = 'Azure is not connected, so the role assignments could not be read.';
export const MIRROR_THROTTLED_MESSAGE =
  'Azure asked RuleBeat to slow down, so the role assignments could not be read. Try again in a few minutes.';
export const MIRROR_FAILED_MESSAGE =
  'The role assignments could not be read from Azure. Check the RuleBeat server logs for details.';

export function mirrorError(code: MirrorErrorCode): MirrorError {
  const message = code === 'azure_not_configured'
    ? MIRROR_NOT_CONNECTED_MESSAGE
    : code === 'throttled' ? MIRROR_THROTTLED_MESSAGE : MIRROR_FAILED_MESSAGE;
  return { code, message };
}

/** When a person's mirror was last read, when it was last tried, and why the last try failed, if it did. */
export interface MirrorStatus {
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  error: MirrorError | null;
}

export const NEVER_MIRRORED: MirrorStatus = Object.freeze({ lastSuccessAt: null, lastAttemptAt: null, error: null });

/**
 * What the Access page says about one person's last refresh. `format` turns a stored time into the reader's
 * own reading of it. A failure says so, when it was tried, and that the Scopes shown are the last ones that
 * loaded; it never repeats Azure's words.
 */
export function describeMirrorStatus(status: MirrorStatus, format: (iso: string) => string): string {
  if (status.error) {
    const tried = status.lastAttemptAt ? ` on ${format(status.lastAttemptAt)}` : '';
    const shown = status.lastSuccessAt
      ? `The Scopes shown are the last ones that loaded, on ${format(status.lastSuccessAt)}.`
      : 'No Scopes have loaded yet.';
    return `The last refresh failed${tried}. ${status.error.message} ${shown}`;
  }
  if (status.lastSuccessAt) return `Last refreshed ${format(status.lastSuccessAt)}.`;
  return 'Not refreshed yet. Use Refresh to read the Linked account from Azure.';
}

/** What the person is told about their own access when the Linked account gives them no Scope. */
export const MIRRORED_NO_SCOPE_MESSAGE =
  'Your Linked account holds no Azure role assignments RuleBeat can see, so no findings are listed for you. Ask an Admin to check the account that is linked.';
