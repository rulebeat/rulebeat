/**
 * What the Access page's Scope picker does to the list it edits, as pure functions so each decision can
 * be tested without rendering anything. Client-safe: no Node, no database.
 *
 * The list is the same shape the Manual access route takes: a path and a Role, one entry a Scope. A
 * Scope is held at most once, and a path is compared without regard to case, as the server does.
 */
import {
  DIRECTORY_SCOPE_PATH, EVERYTHING_SCOPE_PATH, managementGroupIdOf, parseScope, sameScopePath,
  type Access, type AccessSource, type GrantRole, type ManualGrant, type ScopeKind,
} from './access-model';
import type { TreeNode } from './management-group-tree';
import { parseObjectId, type ScopeOrigin } from './access-mirror-model';
import type { AppUserWithAccess } from './access';

export const subscriptionScopePath = (subscriptionId: string): string => `/subscriptions/${subscriptionId}`;
export const managementGroupScopePath = (id: string): string => `/providers/Microsoft.Management/managementGroups/${id}`;
export const resourceGroupScopePath = (subscriptionId: string, name: string): string =>
  `/subscriptions/${subscriptionId}/resourceGroups/${name}`;

export function heldAt(grants: readonly ManualGrant[], path: string): ManualGrant | undefined {
  return grants.find(g => sameScopePath(g.scope, path));
}

/** Holds the Scope at `role` when it is not held, and drops it when it is. */
export function toggleGrant(grants: readonly ManualGrant[], path: string, role: GrantRole): ManualGrant[] {
  return heldAt(grants, path) ? grants.filter(g => !sameScopePath(g.scope, path)) : [...grants, { scope: path, role }];
}

/** Holds the Scope at `role` unless it is already held, in which case the list is returned as it was. Unlike a toggle, it never removes. */
export function addGrant(grants: readonly ManualGrant[], path: string, role: GrantRole): ManualGrant[] {
  return heldAt(grants, path) ? [...grants] : [...grants, { scope: path, role }];
}

export function setGrantRole(grants: readonly ManualGrant[], path: string, role: GrantRole): ManualGrant[] {
  return grants.map(g => (sameScopePath(g.scope, path) ? { ...g, role } : g));
}

/** The Role at every Scope at once, which is what the person-level Role select means. */
export function setEveryRole(grants: readonly ManualGrant[], role: GrantRole): ManualGrant[] {
  return grants.map(g => ({ ...g, role }));
}

/** The Scopes a person holds as the picker edits them, a management group included: saving the list
 *  replaces what they hold, so a group left out here would be removed by an Edit that changed nothing. */
export function grantsOfAccess(access: Pick<Access, 'grants'>): ManualGrant[] {
  const out: ManualGrant[] = [];
  for (const g of access.grants) {
    if (g.role === 'admin') continue;
    out.push({ scope: g.scope.path, role: g.role });
  }
  return out;
}

/** The resource groups held inside one subscription, by name, in the order they were chosen. */
export function resourceGroupsHeld(grants: readonly ManualGrant[], subscriptionId: string): string[] {
  const prefix = `${subscriptionScopePath(subscriptionId)}/resourcegroups/`.toLowerCase();
  return grants
    .filter(g => g.scope.toLowerCase().startsWith(prefix) && parseScope(g.scope)?.kind === 'resourceGroup')
    .map(g => g.scope.slice(prefix.length));
}

/** A subscription the picker can offer, as `/api/azure/subscriptions` answers it. */
export interface SubscriptionOption {
  id: string;
  name: string;
}

/** What the picker knows of Azure. `null` is not loaded (yet, or it failed), which is not the same as empty. */
export interface PickerCatalogue {
  nodes: readonly TreeNode[] | null;
  subscriptions: readonly SubscriptionOption[] | null;
}

/** One management group or subscription a search can add. */
export interface ScopeCandidate {
  kind: 'managementGroup' | 'subscription';
  id: string;
  name: string;
  path: string;
}

const lower = (text: string): string => text.toLowerCase();

/**
 * Searches the management groups and subscriptions by display name or id, in any casing. Nothing matches a
 * blank query: the picker offers no list to browse. Groups come before subscriptions, each by name. A
 * subscription both lists know is one candidate, and takes the name Azure gave the subscription list.
 */
export function searchScopes(query: string, catalogue: PickerCatalogue): ScopeCandidate[] {
  const q = lower(query.trim());
  if (q === '') return [];
  const groups: ScopeCandidate[] = [];
  const subscriptions = new Map<string, ScopeCandidate>();
  for (const node of catalogue.nodes ?? []) {
    if (node.kind === 'managementGroup') {
      groups.push({ kind: 'managementGroup', id: node.id, name: node.name, path: managementGroupScopePath(node.id) });
    } else {
      subscriptions.set(lower(node.id), { kind: 'subscription', id: node.id, name: node.name, path: subscriptionScopePath(node.id) });
    }
  }
  for (const sub of catalogue.subscriptions ?? []) {
    subscriptions.set(lower(sub.id), { kind: 'subscription', id: sub.id, name: sub.name, path: subscriptionScopePath(sub.id) });
  }
  const byName = (a: ScopeCandidate, b: ScopeCandidate) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const matches = (c: ScopeCandidate) => lower(c.name).includes(q) || lower(c.id).includes(q);
  return [...groups.filter(matches).sort(byName), ...[...subscriptions.values()].filter(matches).sort(byName)];
}

/**
 * The nodes of the tree whose name or id contains the query, in any casing, and every group above each of them,
 * so a match is still read under its parents. A blank query keeps the whole tree.
 */
export function filterTree<T extends TreeNode>(nodes: readonly T[], query: string): T[] {
  const q = lower(query.trim());
  if (q === '') return [...nodes];
  const keep = new Set<T>();
  for (const node of nodes) {
    if (!lower(node.name).includes(q) && !lower(node.id).includes(q)) continue;
    keep.add(node);
    for (const parent of groupsAbove(nodes, node.kind, node.id)) {
      const group = nodes.find(n => n.kind === 'managementGroup' && lower(n.id) === parent);
      if (group) keep.add(group);
    }
  }
  return nodes.filter(n => keep.has(n));
}

/** The Role a row's control shows: the Role an Admin is being demoted to while that panel is open, else the stored one. */
export function shownRole<R extends string>(user: { id: string; role: R }, demoting: { id: string; role: R } | null): R {
  return demoting?.id === user.id ? demoting.role : user.role;
}

/** The resource group names that contain the query, in any casing, by name. A blank query keeps them all. */
export function searchResourceGroups(names: readonly string[], query: string): string[] {
  const q = lower(query.trim());
  return names.filter(n => lower(n).includes(q)).sort((a, b) => a.localeCompare(b));
}

/** The groups above a management group or a subscription, nearest first, lowercase. A loop in the tree ends. */
function groupsAbove(nodes: readonly TreeNode[], kind: TreeNode['kind'], id: string): string[] {
  const out: string[] = [];
  const seen = new Set([lower(id)]);
  let current = nodes.find(n => n.kind === kind && lower(n.id) === lower(id));
  while (current?.parentId) {
    const parent = lower(current.parentId);
    if (seen.has(parent)) break;
    seen.add(parent);
    out.push(parent);
    current = nodes.find(n => n.kind === 'managementGroup' && lower(n.id) === parent);
  }
  return out;
}

/**
 * The short path of a management group, root first: "Tenant Root Group › mg-enterprise". A deep one keeps
 * its root and its last two names with an ellipsis between. A group the tree does not hold is its id alone.
 */
export function managementGroupPathLabel(nodes: readonly TreeNode[], id: string): string {
  const own = nodes.find(n => n.kind === 'managementGroup' && lower(n.id) === lower(id));
  if (!own) return id;
  const names = [own.name];
  for (const parent of groupsAbove(nodes, 'managementGroup', id)) {
    names.unshift(nodes.find(n => n.kind === 'managementGroup' && lower(n.id) === parent)?.name ?? parent);
  }
  return names.length > 3 ? [names[0]!, '…', ...names.slice(-2)].join(' › ') : names.join(' › ');
}

const ROLE_RANK: Record<GrantRole, number> = { viewer: 1, editor: 2 };

/**
 * The held Scope that already gives someone `path` at `role` or higher, or null when none does. Everything
 * covers all. A management group covers the groups below it, the subscriptions under any of them (by the tree)
 * and those subscriptions' resource groups; a subscription covers its resource groups. The Directory is covered
 * by Everything alone. A Scope held at a lower Role does not cover it: an Editor on a subscription under a
 * Viewer management group is a real addition. The same Scope held at the same or a higher Role is covered too.
 */
export function coveringGrant(
  held: readonly ManualGrant[], nodes: readonly TreeNode[], path: string, role: GrantRole,
): ManualGrant | null {
  const target = parseScope(path);
  if (!target) return null;
  const parts = path.split('/');
  const above = target.kind === 'managementGroup' ? groupsAbove(nodes, 'managementGroup', managementGroupIdOf(path))
    : target.kind === 'subscription' || target.kind === 'resourceGroup' ? groupsAbove(nodes, 'subscription', parts[2]!)
      : [];
  for (const grant of held) {
    if (ROLE_RANK[grant.role] < ROLE_RANK[role]) continue;
    const scope = parseScope(grant.scope);
    if (!scope) continue;
    if (scope.kind === 'everything' || sameScopePath(grant.scope, path)) return grant;
    if (scope.kind === 'subscription' && target.kind === 'resourceGroup' && lower(path).startsWith(`${lower(grant.scope)}/`)) return grant;
    if (scope.kind === 'managementGroup' && above.includes(lower(managementGroupIdOf(grant.scope)))) return grant;
  }
  return null;
}

/**
 * Why an offered Scope cannot be added, or null when it can: it is already held (at whatever Role, which a held
 * row changes with "Different Role here"), or a held Scope already covers it at the same or a higher Role.
 */
export function offerStatus(
  held: readonly ManualGrant[], nodes: readonly TreeNode[], path: string, role: GrantRole, names: Readonly<Record<string, string>> = {},
): string | null {
  const own = heldAt(held, path);
  if (own) return `Held at ${own.role === 'editor' ? 'Editor' : 'Viewer'}`;
  const covering = coveringGrant(held, nodes, path, role);
  return covering ? `Covered by ${describeScopePath(covering.scope, names)}` : null;
}

/**
 * Whether a held Scope's Role is the person's own and cannot be changed in place. A Scope takes the person's Role
 * when added; "Different Role here" unlocks it, and one saved with another Role loads unlocked, so the Role
 * it has is never hidden or overwritten. `unlocked` holds lowercase paths.
 */
export function roleLocked(grant: ManualGrant, personRole: GrantRole, unlocked: ReadonlySet<string>): boolean {
  return grant.role === personRole && !unlocked.has(lower(grant.scope));
}

/** The names of what the picker knows, keyed by lowercase id, for `describeScopePath`. */
export function namesOf(catalogue: PickerCatalogue): Record<string, string> {
  const names: Record<string, string> = {};
  for (const node of catalogue.nodes ?? []) names[lower(node.id)] = node.name;
  for (const sub of catalogue.subscriptions ?? []) names[lower(sub.id)] = sub.name;
  return names;
}

export const KIND_LABELS: Record<ScopeKind, string> = {
  everything: 'Everything',
  directory: 'Directory',
  managementGroup: 'Management group',
  subscription: 'Subscription',
  resourceGroup: 'Resource group',
};

export const EVERYTHING_DETAIL = 'Every subscription, resource group and the Directory, including anything added later';
export const DIRECTORY_DETAIL = 'Entra ID: app registrations, users and the other findings that sit in no subscription';
export const MISSING_GROUP_DETAIL = 'Not in the tree RuleBeat has loaded. Remove it, or refresh the tree.';

/** The three empty states of "Add access". Each says why there is nothing to pick, so none reads as another. */
export const GROUPS_LOAD_FAILED_MESSAGE = 'Management groups could not be loaded, so none can be chosen. Check the server logs.';
export const NO_SUBSCRIPTIONS_MESSAGE = 'No subscriptions were found. Connect Azure in Settings to choose a subscription or a resource group.';
export const nothingMatchedMessage = (query: string): string => `Nothing matched “${query.trim()}”. Try part of a name or an id.`;

/** One Scope the person holds, as the held list shows it. */
export interface HeldRow {
  path: string;
  kind: ScopeKind;
  label: string;
  /** The short management group path, a subscription's id, or the subscription of a resource group. */
  detail: string | null;
  role: GrantRole;
  /** A management group the person holds that the loaded tree no longer has. It stays listed so it can be removed. */
  missing: boolean;
}

/**
 * The held list: one row per Scope in the list, in the list's own order, so a list nobody changed reads and
 * saves back exactly as it was. A management group missing from the tree is a row marked `missing`, never dropped.
 */
export function heldRows(grants: readonly ManualGrant[], catalogue: PickerCatalogue): HeldRow[] {
  const names = namesOf(catalogue);
  return grants.map((grant): HeldRow => {
    const kind = parseScope(grant.scope)?.kind ?? 'resourceGroup';
    const base = { path: grant.scope, kind, role: grant.role, missing: false };
    const parts = grant.scope.split('/');
    switch (kind) {
      case 'everything': return { ...base, label: 'Everything', detail: EVERYTHING_DETAIL };
      case 'directory': return { ...base, label: 'Directory', detail: DIRECTORY_DETAIL };
      case 'managementGroup': {
        const id = managementGroupIdOf(grant.scope);
        if (catalogue.nodes === null) return { ...base, label: id, detail: null };
        const known = catalogue.nodes.some(n => n.kind === 'managementGroup' && lower(n.id) === lower(id));
        return known
          ? { ...base, label: names[lower(id)] ?? id, detail: managementGroupPathLabel(catalogue.nodes, id) }
          : { ...base, label: id, detail: MISSING_GROUP_DETAIL, missing: true };
      }
      case 'subscription': {
        const name = names[lower(parts[2]!)];
        return { ...base, label: name ?? parts[2]!, detail: name && name !== parts[2] ? parts[2]! : null };
      }
      default:
        return { ...base, label: parts[4] ?? grant.scope, detail: `in ${names[lower(parts[2] ?? '')] ?? parts[2] ?? ''}` };
    }
  });
}

/** Whether two lists hold the same Scopes at the same Roles, in any order and any casing. */
export function sameGrants(a: readonly ManualGrant[], b: readonly ManualGrant[]): boolean {
  return a.length === b.length && a.every(g => heldAt(b, g.scope)?.role === g.role);
}

/**
 * What Save sends for an Edit, or null when it sends nothing. A Manual list nobody changed is not sent: the
 * access route would refuse a held management group the tree no longer has, for a save that changes nothing. A
 * mirrored person is always sent, since saving is what turns them manual.
 */
export function editSaveRequest(
  initial: readonly ManualGrant[], next: readonly ManualGrant[], source: AccessSource | null,
): ManualGrant[] | null {
  return source !== 'mirrored' && sameGrants(initial, next) ? null : [...next];
}

/** What a request answered, as far as the demote steps read it. */
export interface DemoteResponse {
  ok: boolean;
  json: () => Promise<unknown>;
}
export type DemoteFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<DemoteResponse>;

export type DemoteToMirroredResult =
  | { ok: true; user: AppUserWithAccess }
  | { ok: false; stage: 'demote'; error: string }
  /** The person was demoted and holds no access: `user` is the row as the demote answered it. */
  | { ok: false; stage: 'mirror'; error: string; user: AppUserWithAccess };

/** What the page says when the mirror step failed after the demote worked. Plain: the person holds nothing now. */
export function demotedWithoutAccessMessage(email: string, role: GrantRole, error: string): string {
  const label = role === 'editor' ? 'Editor' : 'Viewer';
  const reason = /[.!?]$/.test(error) ? error : `${error}.`;
  return `${email} was demoted to ${label} and now holds no access, so they see no findings. The Linked account was not saved: ${reason} Try again, or choose Manual access.`;
}

/**
 * Demotes an Admin to Mirrored access in the steps the routes allow: demote with no Scopes, then mirror the
 * Linked account. The mirror route refuses an Admin, so the demote comes first, and it is never done with
 * Everything: if the mirror fails the person holds nothing, which is the safe way to fail. `demoted` skips the
 * demote when an earlier try already did it. The preview before both is the invite preview and takes no person.
 */
export async function demoteToMirrored(
  input: { userId: string; role: GrantRole; objectId: string; demoted?: AppUserWithAccess },
  send: DemoteFetch,
): Promise<DemoteToMirroredResult> {
  async function call(method: string, url: string, body: unknown): Promise<{ ok: boolean; body: Record<string, unknown> }> {
    try {
      const res = await send(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { ok: res.ok, body: (await res.json()) as Record<string, unknown> };
    } catch {
      return { ok: false, body: { error: 'Could not reach the RuleBeat server.' } };
    }
  }
  const message = (body: Record<string, unknown>, fallback: string) => (typeof body.error === 'string' ? body.error : fallback);
  const id = encodeURIComponent(input.userId);

  let user = input.demoted ?? null;
  if (!user) {
    const demote = await call('PUT', `/api/users/${id}`, { role: input.role, access: [] });
    if (!demote.ok) return { ok: false, stage: 'demote', error: message(demote.body, 'Could not demote this person.') };
    user = demote.body as unknown as AppUserWithAccess;
  }
  const mirror = await call('PUT', `/api/users/${id}/mirror`, { objectId: input.objectId, role: input.role });
  if (!mirror.ok) return { ok: false, stage: 'mirror', error: message(mirror.body, 'Could not save this access.'), user };
  return { ok: true, user: mirror.body as unknown as AppUserWithAccess };
}

/** What a Scope is called on screen. `names` maps a subscription id or a management group id to its display name. */
export function describeScopePath(path: string, names: Readonly<Record<string, string>> = {}): string {
  if (path === EVERYTHING_SCOPE_PATH) return 'Everything';
  if (path.toLowerCase() === DIRECTORY_SCOPE_PATH) return 'Directory';
  const scope = parseScope(path);
  const parts = path.split('/');
  const named = (id: string) => names[id] ?? names[id.toLowerCase()] ?? id;
  if (scope?.kind === 'subscription') return named(parts[2]!);
  if (scope?.kind === 'resourceGroup') return `${parts[4]!} in ${named(parts[2]!)}`;
  if (scope?.kind === 'managementGroup') return `Management group ${named(parts[parts.length - 1]!)}`;
  return path;
}

/** Whether a list can be sent as an invite: an invited Viewer or Editor must be given something. */
export function canInvite(email: string, grants: readonly ManualGrant[]): boolean {
  return email.trim() !== '' && grants.length > 0;
}

/**
 * Whether "Use their sign-in account" is offered: the person has signed in with Entra, so RuleBeat holds an
 * object id for them, and the sign-in tenant is the one the Azure connection reads, so that id means the same
 * account there. It only ever fills the field: it is never the default, so a separate admin account is a
 * deliberate choice and a forgotten step grants nothing.
 */
export function canUseSignInAccount(user: { oid: string | null; role: string }, signInTenantIsAzureTenant: boolean): boolean {
  return signInTenantIsAzureTenant && user.role !== 'admin' && typeof user.oid === 'string' && user.oid !== '';
}

/** Whether what was typed in the Linked account field is an object id the routes will take. */
export function canPreviewMirror(objectId: string): boolean {
  return parseObjectId(objectId) !== null;
}

/**
 * Whether an invite with Mirrored access can be sent: an email, and a preview of the account in the field now.
 * Changing the object id after a preview needs a new one, so the Admin always adds what they last saw.
 */
export function canInviteMirrored(email: string, objectId: string, previewedId: string | null): boolean {
  return email.trim() !== '' && canPreviewMirror(objectId) && previewedId === objectId.trim();
}

/** What Edit says over a mirrored person's Scopes: saving them turns the person manual. */
export const EDIT_STOPS_MIRROR_NOTE =
  'This person has Mirrored access. Saving here stops the mirror: the Scopes below stay as they are and become Manual access.';

/** One Scope of a preview, as the routes answer it. */
export interface PreviewedScope {
  scope: string;
  origins: readonly ScopeOrigin[];
}

/** What the page says over the previewed Scopes, or in place of them when there are none. */
export function previewHeading(scopes: readonly PreviewedScope[], email: string): string {
  if (scopes.length === 0) {
    return `This account holds no role assignments RuleBeat can see, so ${email} would see no findings.`;
  }
  return `${email} would get ${scopes.length} ${scopes.length === 1 ? 'Scope' : 'Scopes'}.`;
}

/** The sentence that tells an Admin their hand-made Scopes are about to be replaced, or null when there are none. */
export function replacesManualNote(access: Pick<Access, 'grants' | 'source'>): string | null {
  if (access.source !== 'manual' || access.grants.length === 0) return null;
  const n = access.grants.length;
  return `Their ${n} Manual ${n === 1 ? 'Scope' : 'Scopes'} will be replaced.`;
}

/** The sentence that names the others already linked to an account, or null when no one is. */
export function alsoLinkedNote(people: readonly { email: string }[]): string | null {
  if (people.length === 0) return null;
  const names = people.map(p => p.email).join(', ');
  return `${names} ${people.length === 1 ? 'is' : 'are'} already linked to this account. Two people on one account see the same findings.`;
}
