/**
 * The saved view a widget may name (#376, ADR 0012): `savedViewId` in the widget's config. A Shared dashboard
 * can use only Shared saved views, so the words a refusal and a widget read use are here, pure, for the
 * routes and the components to read the same text. The widget catalogue (#330) decides how a resolved view's
 * filter combines with the dashboard's and the widget's; this only says which view a widget names and what
 * state it is in.
 */

/** What a widget read says when the view exists but is now someone else's Personal view. */
export const SAVED_VIEW_NOT_SHARED = 'This saved view is no longer shared with you';

/** What a widget read says when the view was deleted. */
export const SAVED_VIEW_MISSING = 'This saved view no longer exists.';

/** The state of the view a widget names, as a widget read reports it. */
export type SavedViewState =
  | { state: 'resolved'; id: string; query: string }
  | { state: 'not-shared'; message: typeof SAVED_VIEW_NOT_SHARED }
  | { state: 'missing'; message: typeof SAVED_VIEW_MISSING };

/** The id of the saved view a widget's config names, or null when it names none. */
export function savedViewIdOf(config: Record<string, unknown> | undefined): string | null {
  const id = config?.['savedViewId'];
  return typeof id === 'string' && id !== '' ? id : null;
}

/** The 400 for a dashboard that is Shared (or being shared) and has widgets on views that are not. It names the widgets, never a view. */
export function sharedDashboardViewsRefusal(widgetTitles: readonly string[]): string {
  return `${widgetTitles.length} widgets use saved views that are no longer shared: ${widgetTitles.join(', ')}. Change or remove them before saving.`;
}

/** The sentence a view's unshare or delete confirmation adds when Shared dashboards use the view. Empty when none does. */
export function sharedDashboardUseNote(count: number, change: 'unshared' | 'deleted'): string {
  if (count === 0) return '';
  const dashboards = `${count} Shared dashboard${count === 1 ? '' : 's'}`;
  const effect = change === 'unshared' ? 'stop being able to open it' : 'lose it';
  return ` ${dashboards} use${count === 1 ? 's' : ''} it, and their widgets will ${effect}.`;
}
