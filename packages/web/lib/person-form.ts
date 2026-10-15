/**
 * The person page (#311): one form holds a person's Role and what they can access, and Save works out which of
 * the user routes to call, in what order. As pure functions so every case can be tested without rendering.
 * Client-safe: no Node, no database.
 *
 * Access is one of three choices. Everything is the one Everything Scope. Selected Scopes is a list picked in the
 * tree. Mirrored follows a Linked account in Azure. Every Scope takes the person's Role: the page never sets a
 * Role per Scope, though the routes and the stored rows still can.
 */
import { EVERYTHING_SCOPE_PATH, highestRole, type GrantRole, type ManualGrant } from './access-model';
import { canPreviewMirror, editSaveRequest, grantsOfAccess, setEveryRole } from './access-picker';
import type { AppUserWithAccess } from './access';
import type { Role } from './rbac';

export type AccessChoice = 'everything' | 'scopes' | 'mirrored';

export interface PersonForm {
  role: Role;
  /** Null until one is chosen: an invited Viewer or Editor is given what an Admin picks, never a default. */
  choice: AccessChoice | null;
  /** The Selected Scopes. */
  grants: ManualGrant[];
  /** The Linked account typed in, blank to keep the one a mirrored person has. */
  objectId: string;
  /** The object id the last preview read, so what is saved is what was last seen. */
  previewedId: string | null;
}

/** One call Save makes. */
export interface SaveStep {
  method: 'POST' | 'PUT';
  url: string;
  body: Record<string, unknown>;
}

export type SavePlan =
  | { kind: 'nothing' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'steps'; steps: SaveStep[] }
  /** An Admin made a mirrored Viewer or Editor: `demoteToMirrored` runs the two steps. */
  | { kind: 'demote-mirrored'; role: GrantRole; objectId: string };

type Person = Pick<AppUserWithAccess, 'id' | 'role' | 'access' | 'accessSource'>;

const everything = (role: GrantRole): ManualGrant[] => [{ scope: EVERYTHING_SCOPE_PATH, role }];

const isOnlyEverything = (grants: readonly ManualGrant[]): boolean =>
  grants.length === 1 && grants[0]!.scope === EVERYTHING_SCOPE_PATH;

/** What the form shows when it opens: the person as they are, or a blank invite with nothing chosen. */
export function initialPersonForm(user: Person | null): PersonForm {
  const blank: PersonForm = { role: 'viewer', choice: null, grants: [], objectId: '', previewedId: null };
  if (!user) return blank;
  if (user.role === 'admin') return { ...blank, role: 'admin' };
  const grants = grantsOfAccess(user.access);
  if (user.accessSource === 'mirrored') return { ...blank, role: user.role, choice: 'mirrored', grants };
  return { ...blank, role: user.role, choice: isOnlyEverything(grants) ? 'everything' : 'scopes', grants };
}

/**
 * The form after the Role is changed. An Admin made a Viewer or Editor keeps Everything until something narrower
 * is chosen, so demoting never takes access away by itself; an invite keeps its choice blank.
 */
export function withRole(form: PersonForm, role: Role, user: Person | null): PersonForm {
  const choice = form.choice === null && user?.role === 'admin' && role !== 'admin' ? 'everything' : form.choice;
  return { ...form, role, choice };
}

/** Whether the person holds Scopes at different Roles, which the page cannot show: saving gives them all one. */
export function mixedRoles(grants: readonly ManualGrant[]): boolean {
  return new Set(grants.map(g => g.role)).size > 1;
}

/** Where a Linked account is previewed: the person's own route, or the one that takes no person for an invite or an Admin. */
export function previewUrl(user: Pick<Person, 'id' | 'role'> | null): string {
  return user && user.role !== 'admin'
    ? `/api/users/${encodeURIComponent(user.id)}/mirror/preview`
    : '/api/users/mirror-preview';
}

/** Why a Linked account cannot be saved yet, or null when it can. */
function mirrorBlocked(form: PersonForm): string | null {
  if (!canPreviewMirror(form.objectId)) return 'Enter the object id of the Linked account.';
  if (form.previewedId !== form.objectId.trim()) return 'Preview the Linked account first.';
  return null;
}

const NO_CHOICE = 'Choose what this person can access.';

function planInvite(form: PersonForm, email: string): SavePlan {
  const to = email.trim();
  if (to === '') return { kind: 'blocked', reason: 'Enter a work email.' };
  const post = (body: Record<string, unknown>): SavePlan => ({ kind: 'steps', steps: [{ method: 'POST', url: '/api/users', body }] });
  if (form.role === 'admin') return post({ email: to, role: 'admin' });
  const role = form.role;
  switch (form.choice) {
    case null: return { kind: 'blocked', reason: NO_CHOICE };
    case 'everything': return post({ email: to, role, source: 'manual', access: everything(role) });
    case 'scopes':
      if (form.grants.length === 0) return { kind: 'blocked', reason: 'Choose at least one Scope.' };
      return post({ email: to, role, source: 'manual', access: setEveryRole(form.grants, role) });
    case 'mirrored': {
      const blocked = mirrorBlocked(form);
      return blocked ? { kind: 'blocked', reason: blocked } : post({ email: to, role, source: 'mirrored', objectId: form.objectId.trim() });
    }
  }
}

/**
 * What Save does: nothing, why it cannot yet, or the calls to make in order. `user` is null for an invite.
 *
 * - An Admin kept an Admin changes nothing; a promotion is one Role change, which drops their Scopes.
 * - An Admin demoted is given their access in the same call, as the route requires, or, for Mirrored, demoted with
 *   none and then linked.
 * - A Viewer or Editor with Everything or Selected Scopes is sent the list, every Scope at their Role, only when
 *   it changed, then the Role when the list alone would not leave them at it (an Editor who holds nothing).
 * - A mirrored person is relinked when a new account was previewed, and otherwise only has their Role changed.
 */
export function planSave(user: Person | null, form: PersonForm, email = ''): SavePlan {
  if (!user) return planInvite(form, email);
  const id = encodeURIComponent(user.id);
  const roleStep = (body: Record<string, unknown>): SaveStep => ({ method: 'PUT', url: `/api/users/${id}`, body });

  if (form.role === 'admin') {
    return user.role === 'admin' ? { kind: 'nothing' } : { kind: 'steps', steps: [roleStep({ role: 'admin' })] };
  }
  const role = form.role;

  if (user.role === 'admin') {
    switch (form.choice) {
      case null: return { kind: 'blocked', reason: NO_CHOICE };
      case 'everything': return { kind: 'steps', steps: [roleStep({ role, access: everything(role) })] };
      case 'scopes': return { kind: 'steps', steps: [roleStep({ role, access: setEveryRole(form.grants, role) })] };
      case 'mirrored': {
        const blocked = mirrorBlocked(form);
        return blocked ? { kind: 'blocked', reason: blocked } : { kind: 'demote-mirrored', role, objectId: form.objectId.trim() };
      }
    }
  }

  if (form.choice === 'mirrored') {
    if (form.objectId.trim() !== '') {
      const blocked = mirrorBlocked(form);
      if (blocked) return { kind: 'blocked', reason: blocked };
      return { kind: 'steps', steps: [{ method: 'PUT', url: `/api/users/${id}/mirror`, body: { objectId: form.objectId.trim(), role } }] };
    }
    if (user.accessSource !== 'mirrored') return { kind: 'blocked', reason: 'Enter the object id of the Linked account.' };
    return role === user.role ? { kind: 'nothing' } : { kind: 'steps', steps: [roleStep({ role })] };
  }
  if (form.choice === null) return { kind: 'blocked', reason: NO_CHOICE };

  const desired = form.choice === 'everything' ? everything(role) : setEveryRole(form.grants, role);
  const access = editSaveRequest(grantsOfAccess(user.access), desired, user.accessSource);
  const steps: SaveStep[] = [];
  if (access) steps.push({ method: 'PUT', url: `/api/users/${id}/access`, body: { access } });
  const roleAfter = access ? highestRole(access) : user.role;
  if (roleAfter !== role) steps.push(roleStep({ role }));
  return steps.length === 0 ? { kind: 'nothing' } : { kind: 'steps', steps };
}
