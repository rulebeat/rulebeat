/**
 * The authorization model. Pure data + one predicate, no DB or Node imports, so the same map
 * drives both the server guard (`requireRole` in lib/api-auth.ts) and the UI's button gating.
 * There is no second copy of "who may do what" to keep in sync.
 *
 * Routes name the *action* they perform, never a role rank. Re-deciding that, say, editors may
 * manage categories is then one edit here rather than a sweep through route files.
 */

import { scopeCovers, type Access, type Scope } from '@/lib/access-model';

export type Role = 'viewer' | 'editor' | 'admin';

export const ROLES: readonly Role[] = ['viewer', 'editor', 'admin'];

export const ROLE_LABELS: Record<Role, string> = {
  viewer: 'Viewer',
  editor: 'Editor',
  admin: 'Admin',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  viewer: 'Read and export everything. Cannot change anything.',
  editor: 'Author rules, run scans, manage schedules, dashboards, saved views and suppressions.',
  admin: 'Everything an editor can do, plus switching rule versions, categories, users, sign-in configuration, the Azure connection, notifications and the audit log.',
};

const VIEWER_ACTIONS = ['read'] as const;

const EDITOR_ACTIONS = [
  ...VIEWER_ACTIONS,
  'rules:write',
  'rules:delete',
  'rules:validate',
  'scans:run',
  'schedules:write',
  'suppressions:write',
  'dashboards:write',
  'views:write',
  'schemas:refresh',
] as const;

const ADMIN_ACTIONS = [
  ...EDITOR_ACTIONS,
  'rules:version',
  'categories:write',
  'users:manage',
  'audit:read',
  'azure:manage',
  'auth:manage',
  'notifications:manage',
] as const;

// account:self sits outside the viewer/editor/admin ladder. Every role can change their own
// password, so it is asserted directly in `can()` rather than added to all three arrays above.
export const ALL_ACTIONS = [...ADMIN_ACTIONS, 'account:self'] as const;

export type Action = typeof ALL_ACTIONS[number];

// Kept as an explicit role→actions map rather than a numeric rank comparison: a custom role
// (a paid feature on the roadmap) then becomes another entry here, not a new mechanism.
const ROLE_ACTIONS: Record<Role, ReadonlySet<Action>> = {
  viewer: new Set(VIEWER_ACTIONS),
  editor: new Set(EDITOR_ACTIONS),
  admin: new Set(ADMIN_ACTIONS),
};

export function can(role: Role, action: Action): boolean {
  // Every real role may manage their own password. It sits outside the viewer/editor/admin
  // ladder rather than being duplicated into all three action arrays above.
  if (action === 'account:self') return isRole(role);
  return ROLE_ACTIONS[role]?.has(action) ?? false;
}

/**
 * What an action touches, which decides where a person must hold a Role for it.
 *
 * - `install-administration`: running the install itself. Admin only, never scoped.
 * - `install-wide`: changes what the whole install shares. A Role on Everything.
 * - `placed`: acts on one finding, so it needs a Role at a Scope containing where that finding sits.
 * - `scoped`: acts inside what the person may see. A Role at any Scope.
 * - `outside`: asks nothing of Scope.
 *
 * An exhaustive record: adding an action without a class is a type error.
 */
export type ActionClass = 'install-administration' | 'install-wide' | 'placed' | 'scoped' | 'outside';

export const ACTION_CLASS: Record<Action, ActionClass> = {
  'rules:version': 'install-administration',
  'categories:write': 'install-administration',
  'users:manage': 'install-administration',
  'audit:read': 'install-administration',
  'azure:manage': 'install-administration',
  'auth:manage': 'install-administration',
  'notifications:manage': 'install-administration',
  'rules:write': 'install-wide',
  'rules:delete': 'install-wide',
  'schedules:write': 'install-wide',
  'dashboards:write': 'install-wide',
  'views:write': 'install-wide',
  'schemas:refresh': 'install-wide',
  'suppressions:write': 'placed',
  'read': 'scoped',
  'rules:validate': 'scoped',
  'scans:run': 'scoped',
  'account:self': 'outside',
};

/**
 * May this access do this action, at this placement. `can(role, action)` stays the one map of what
 * a Role allows; this only decides where the Role has to be held.
 *
 * A placed or scoped action called with no placement needs a Role at any Scope that allows it.
 * `read` passes for any signed-in person: a person with no Scope reads an empty install, and the
 * reads themselves are what narrow to a Scope (#270).
 */
export function mayAct(access: Access, action: Action, placement?: Scope): boolean {
  if (action === 'read') return true;
  switch (ACTION_CLASS[action]) {
    case 'outside':
      return true;
    case 'install-administration':
      return access.grants.some(g => g.scope.kind === 'everything' && g.role === 'admin' && can(g.role, action));
    case 'install-wide':
      return access.grants.some(g => g.scope.kind === 'everything' && can(g.role, action));
    case 'placed':
    case 'scoped':
      return access.grants.some(g =>
        can(g.role, action) && (placement === undefined || scopeCovers(g.scope, placement)));
    default:
      return false;
  }
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
