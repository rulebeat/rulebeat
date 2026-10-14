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
