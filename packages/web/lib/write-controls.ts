/**
 * Which write controls a person gets on the library, rule, Scans and Suppressions screens, and why a
 * control they might expect is off (#275). Pure, no DB or Node imports: a server page computes it
 * from `mayAct` and hands it to the client, so the screen and the route that refuses the write agree.
 *
 * What a page or a sidebar item exists for stays on `can(role, action)`. This is only about a control
 * on a screen the person can already open.
 */
import type { Access } from './access-model';
import { can, mayAct } from './rbac';

export interface WriteControls {
  /** Create, edit, enable and disable, tag, bulk change and duplicate a rule. */
  rulesWrite: boolean;
  /** Delete a rule and clear its findings. */
  rulesDelete: boolean;
  /** Create, edit, enable, disable and delete a schedule. */
  schedulesWrite: boolean;
  /** Suppress a finding. True for an Editor at any Scope: the route checks where the finding sits. */
  suppress: boolean;
  /**
   * Set only when a Role the person holds allows a library or schedule write but none of those Roles is
   * held on Everything: the controls are shown off with this text. Absent for a Viewer, who is shown what
   * a Viewer is shown today, and for anyone who may write.
   */
  reason?: string;
}

export const SCOPED_WRITE_REASON =
  'Changing rules and schedules affects the whole install. It needs an Admin, or an Editor on Everything. Your Editor access covers only part of it.';

export const SCOPED_CATEGORY_REASON =
  'Changing categories affects the whole install. It needs an Admin, or an Editor on Everything. Your Editor access covers only part of it.';

/**
 * The category controls on the Settings page: `allowed` from `mayAct`, and a `reason` set only when a Role the
 * person holds allows `categories:write` but none of those Roles is held on Everything. A Viewer gets no reason.
 */
export function categoryControlFor(access: Access): { allowed: boolean; reason?: string } {
  const allowed = mayAct(access, 'categories:write');
  const heldButScoped = !allowed && access.grants.some(g => can(g.role, 'categories:write'));
  return { allowed, ...(heldButScoped ? { reason: SCOPED_CATEGORY_REASON } : {}) };
}

export const SHARE_REASON = 'Sharing needs an Editor Role at some Scope.';

/**
 * The Share control on a dashboard or saved view: `allowed` from `mayAct` on the kind's write action, and the
 * reason it is off when it is not. Its own field, so a screen shows why without working it out from the Role.
 */
export function shareControlFor(access: Access, kind: 'dashboard' | 'view'): { allowed: boolean; reason?: string } {
  const allowed = mayAct(access, kind === 'dashboard' ? 'dashboards:write' : 'views:write');
  return allowed ? { allowed } : { allowed, reason: SHARE_REASON };
}

export const INSTALL_DEFAULT_REASON =
  'The Install default is chosen, unshared and deleted by an Admin or an Editor on Everything. Choose another one first, or ask one of them.';

/**
 * The Unshare and Delete controls on the Install default: `allowed` from `mayAct` on `dashboards:manage`, and the
 * reason they are off when it is not. The owner of the Install default who may not manage still edits its contents.
 */
export function installDefaultControlFor(access: Access): { allowed: boolean; reason?: string } {
  const allowed = mayAct(access, 'dashboards:manage');
  return allowed ? { allowed } : { allowed, reason: INSTALL_DEFAULT_REASON };
}

const INSTALL_WIDE_WRITES = ['rules:write', 'rules:delete', 'schedules:write'] as const;

export function writeControlsFor(access: Access): WriteControls {
  const rulesWrite = mayAct(access, 'rules:write');
  const rulesDelete = mayAct(access, 'rules:delete');
  const schedulesWrite = mayAct(access, 'schedules:write');
  const heldButScoped = INSTALL_WIDE_WRITES.some(action => !mayAct(access, action) && access.grants.some(g => can(g.role, action)));
  return {
    rulesWrite,
    rulesDelete,
    schedulesWrite,
    suppress: mayAct(access, 'suppressions:write'),
    ...(heldButScoped ? { reason: SCOPED_WRITE_REASON } : {}),
  };
}
