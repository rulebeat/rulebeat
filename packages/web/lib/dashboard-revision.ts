/**
 * The dashboard page holds one revision (ADR 0013). A counting response computed from a newer one says
 * the dashboard changed underneath the page, so the bar and every number reload together. A layout edit
 * that is open is not discarded by that reload: the page keeps the layout it holds and takes the newer
 * one when the edit ends. The filters are not part of that layout, and the server counts with the
 * newest saved filters whatever the page holds, so the bar follows the newest revision at once. Pure
 * and client-safe.
 */

export const CHANGED_NOTICE_RELOADED =
  'This dashboard changed since you opened it. The filter bar and every number were reloaded. Your changes are still in the address.';
export const CHANGED_NOTICE_DEFERRED =
  'This dashboard changed since you opened it. The filter bar and every number were reloaded. Your layout edit is still open: save or cancel it to load the new layout. Your changes are still in the address.';

export interface RevisionView {
  /** The revision the page shows. */
  held: number;
  /** The newest revision already reacted to, so the widgets that report it together cause one reload. */
  handled: number;
}

/** Whether a response computed from `seen` calls for a reload. */
export function seeRevision(view: RevisionView, seen: number): { view: RevisionView; newer: boolean } {
  if (seen <= view.held || seen === view.handled) return { view, newer: false };
  return { view: { ...view, handled: seen }, newer: true };
}

/** What to do with the dashboard a reload brought: take it, hold the edit first, or keep what is shown. */
export function incomingDashboard(input: { held: number; incoming: number; layoutEditOpen: boolean }): 'adopt' | 'defer' | 'same' {
  if (input.incoming <= input.held) return 'same';
  return input.layoutEditOpen ? 'defer' : 'adopt';
}

/** Of two accounts of one dashboard, the newer revision; a tie goes to `incoming`, the one just received. */
export function latestOf<T extends { revision: number }>(held: T, incoming: T): T {
  return incoming.revision >= held.revision ? incoming : held;
}

export function noticeFor(action: 'adopt' | 'defer'): string {
  return action === 'adopt' ? CHANGED_NOTICE_RELOADED : CHANGED_NOTICE_DEFERRED;
}

/** The revision a counting response says it was computed from. */
export function reportedRevision(body: unknown): number | undefined {
  const revision = (body as { revision?: unknown } | null)?.revision;
  return typeof revision === 'number' ? revision : undefined;
}
