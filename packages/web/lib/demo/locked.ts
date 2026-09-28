import type { Action } from '../rbac';

/**
 * The Locked surfaces of a Demo: parts of the console every Visitor can see but not change, because
 * a Reset only cleans them up after the fact. Pure data with no imports beyond a type, so the server
 * guard (`requireRole()` in lib/api-auth.ts) and the settings UI read the same list and the same
 * wording.
 *
 * Keyed by action, not by route. Every route that changes one of these surfaces already names one
 * of these actions, so a new route on a Locked surface is locked the day it is written.
 */
const LOCKED_SURFACE_MESSAGES: Partial<Record<Action, string>> = {
  'azure:manage': 'The Azure connection is locked in the Demo. A Demo never connects to Azure, and a secret pasted here would be visible to every Visitor.',
  'auth:manage': 'Sign-in configuration is locked in the Demo. Every Visitor is signed in automatically as the same admin.',
  'users:manage': 'Users are locked in the Demo. Every Visitor shares the one Demo account.',
  'account:self': 'Users are locked in the Demo. Every Visitor shares the one Demo account.',
};

/** Why `action` cannot be performed in a Demo, or null when a Visitor may perform it. */
export function lockedSurfaceMessage(action: Action): string | null {
  return LOCKED_SURFACE_MESSAGES[action] ?? null;
}
