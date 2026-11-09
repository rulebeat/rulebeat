/**
 * The notice a person reads when their save of the dashboard's filters met a newer revision (ADR 0013):
 * who changed the saved filters, when, and which dimensions moved under them. Pure and client-safe.
 */
import { sameValues } from './dashboard-filters';
import { sameWindow, type DashboardFilterChanges } from './finding-view';
import { BAR_LIST_DIMENSIONS, type BarDimension, type DashboardBarState } from './dashboard-bar';

const DIMENSION_NAME: Record<BarDimension, string> = {
  category: 'Category', rule: 'Rule', subscription: 'Subscription', resourceGroup: 'Resource group', tags: 'Tags', severity: 'Severity', window: 'Date window',
};

/** The time of a save, with the date added when it was not today, so an earlier day never reads as a time alone. */
export function timeLabel(iso: string, now: Date = new Date()): string {
  const when = new Date(iso);
  const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return when.toDateString() === now.toDateString()
    ? time
    : `${when.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

const defaultTime = (iso: string) => timeLabel(iso);

function joined(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The dimensions whose effective value moved between the bar the person had and the one the newer
 * revision brought, leaving out those the person changed: their own value still wins there. A held-back
 * count moving counts too, since it changes what the numbers include.
 */
export function movedDimensions(before: DashboardBarState, after: DashboardBarState, changes: DashboardFilterChanges): string[] {
  const moved: string[] = [];
  for (const dim of BAR_LIST_DIMENSIONS) {
    if (changes[dim] !== undefined) continue;
    const a = before.dimensions[dim];
    const b = after.dimensions[dim];
    if (!sameValues(a.effective, b.effective) || a.outside.saved !== b.outside.saved) moved.push(DIMENSION_NAME[dim]);
  }
  if (changes.window === undefined && !sameWindow(before.window.effective, after.window.effective)) moved.push(DIMENSION_NAME.window);
  return moved;
}

/** The one notice for a save that met a newer revision. A second Save is the person's deliberate choice. */
export function conflictNotice(input: { by?: string; at?: string; moved: string[]; formatTime?: (iso: string) => string; layoutEditOpen?: boolean }): string {
  const { by, at, moved, formatTime = defaultTime, layoutEditOpen } = input;
  const head = by && at
    ? `${by} changed this dashboard's saved filters at ${formatTime(at)}.`
    : 'This dashboard changed since you opened it.';
  const also = moved.length > 0 ? ` This also changed ${joined(moved)} for you.` : '';
  const layout = layoutEditOpen ? ' Your layout edit is still open: save or cancel it to load the new layout.' : '';
  return `${head}${also} Your changes are still in the address. Check them, then save again.${layout}`;
}

export const UNAVAILABLE_NOTICE = 'This dashboard is no longer available to you';
