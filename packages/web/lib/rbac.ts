/**
 * The authorization model. Pure data + one predicate, no DB or Node imports, so the same map
 * drives both the server guard (`requireRole` in lib/api-auth.ts) and the UI's button gating —
 * there is no second copy of "who may do what" to keep in sync.
 *
 * Routes name the *action* they perform, never a role rank. Re-deciding that, say, editors may
 * manage categories is then one edit here rather than a sweep through route files.
 */

export type Role = 'viewer' | 'editor' | 'admin';

export const ROLES: readonly Role[] = ['viewer', 'editor', 'admin'];

export const ROLE_LABELS: Record<Role, string> = {
  viewer: 'Viewer',
  editor: 'Editor',
  admin: 'Admin',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  viewer: 'Read and export everything. Cannot change anything.',
  editor: 'Author rules, run scans, manage schedules, dashboards and suppressions.',
  admin: 'Everything an editor can do, plus categories, users, sign-in configuration, the Azure connection, notifications and the audit log.',
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
  'schemas:refresh',
] as const;

const ADMIN_ACTIONS = [
  ...EDITOR_ACTIONS,
  'categories:write',
  'users:manage',
  'audit:read',
  'azure:manage',
  'auth:manage',
  'notifications:manage',
] as const;

// account:self sits outside the viewer/editor/admin ladder — every role can change their own
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
  // Every real role may manage their own password — it sits outside the viewer/editor/admin
  // ladder rather than being duplicated into all three action arrays above.
  if (action === 'account:self') return isRole(role);
  return ROLE_ACTIONS[role]?.has(action) ?? false;
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
