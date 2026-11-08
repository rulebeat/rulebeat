/**
 * Held-back values (#363, ADR 0012): a stored filter value outside the viewer's Access. A dashboard or a
 * saved view is shared, so it can name a subscription, a resource group, a resource or a returned-column
 * value the viewer cannot see. The server never sends such a value. It sends the item without it and one
 * count per place and dimension, and the page says "N outside your access" where the values would be.
 *
 * This is the client-safe half: the label, the shape of a count and the words and lookups the components
 * share. What decides which values are held back, a findings query included, is lib/db/held-back.ts.
 */
import { isRowField, viewFromSearchParams, viewToSearchParams } from './finding-view';

/** What a chip, a select or an empty widget reads in place of a value outside the person's Access. */
export const OUTSIDE_ACCESS_LABEL = 'Outside your access';

/**
 * What a save is refused with (400) when it brings in a value outside the saver's Access that the item did not
 * already store. The same words whether a finding outside their Access carries the value or none does.
 */
export const UNSEEN_VALUE_MESSAGE = "No finding you can see has this value, so it can't be saved.";

export type HeldBackPlace = 'dashboard' | 'widget' | 'savedView';

/**
 * How many stored values of one dimension a place holds that the viewer's Access does not reach. The
 * `dimension` is the filter's field name (`subscription`, `resourceGroup`, `resourceName` or `row.<path>`),
 * never a value. `id` is the dashboard's, the widget's or the saved view's own.
 */
export interface HeldBack {
  place: HeldBackPlace;
  id: string;
  dimension: string;
  count: number;
}

/** The revision a save names: the one of the copy the person was sent, which the save is made on. */
export function claimedRevision(body: unknown): number | undefined {
  const revision = (body as { revision?: unknown } | null)?.revision;
  return typeof revision === 'number' && Number.isInteger(revision) ? revision : undefined;
}

/**
 * The copy a save was made from, exactly as the server sent it: what the person's edit is measured against.
 * The values the server left out of that copy are the ones it puts back, whatever the person's Access is by
 * the time they save. It is a query for a saved view and a config for a dashboard.
 */
export function openedCopy(body: unknown): unknown {
  return (body as { opened?: unknown } | null)?.opened;
}

/** The held-back count for one place and dimension, 0 when there is none. */
export function heldBackCount(
  heldBack: readonly HeldBack[] | undefined, place: HeldBackPlace, id: string, dimension: string,
): number {
  return heldBack?.find(h => h.place === place && h.id === id && h.dimension === dimension)?.count ?? 0;
}

/** What the chip beside a dimension's visible values reads: a count, or only the label when the dimension
 *  has no visible value left. */
export function heldBackNote(count: number, visible: number): string {
  return visible > 0 ? `${count} outside your access` : OUTSIDE_ACCESS_LABEL;
}

/**
 * Whether a dimension has held-back values and nothing the viewer can see. Such a filter matches nothing
 * for them: dropping the values from the response must not read as "no filter", which would show them the
 * whole of their own Access in place of what the item was set up to show.
 */
export function onlyHeldBack(
  heldBack: readonly HeldBack[] | undefined, place: HeldBackPlace, id: string, dimension: string, visible: number,
): boolean {
  return visible === 0 && heldBackCount(heldBack, place, id, dimension) > 0;
}

/**
 * The values of a filter the Scans bar draws as chips of their own. A saved view whose dimension is held back in
 * full opens holding the placeholder `OUTSIDE_ACCESS_LABEL`, which keeps the list empty for this viewer. It is not a
 * value they chose and cannot drop: the held-back chip stands for it, with no remove control.
 */
export function valuesWithoutPlaceholder(
  heldBack: readonly HeldBack[] | undefined, dimension: string, values: readonly string[],
): string[] {
  const held = heldBack?.some(h => h.dimension === dimension) ?? false;
  return held ? values.filter(value => value !== OUTSIDE_ACCESS_LABEL) : [...values];
}

const SCOPE_DIMENSIONS = [
  { key: 'subscriptions', dimension: 'subscription', noun: 'subscriptions' },
  { key: 'resourceGroups', dimension: 'resourceGroup', noun: 'resource groups' },
] as const;

/**
 * What a widget says in place of a number when every subscription (or every resource group) it is filtered
 * to is held back from the viewer. The held values are not in the config the browser has, so without this
 * the filter would read as empty and the widget would draw the viewer's whole Access: a posture of 100%,
 * "No violations found" or "All rules passing" would claim something was checked and found clean, when
 * nothing it was set up to show is theirs to see.
 *
 * A widget's own list replaces the dashboard's for a dimension (mergeWidgetFilters), so the widget is
 * looked at first and the filter bar only when the widget names none.
 */
export function widgetHeldBackReason(
  heldBack: readonly HeldBack[] | undefined,
  dashboardId: string,
  widget: { id: string; config: Record<string, unknown> },
  filterBar: { subscriptions: readonly string[]; resourceGroups: readonly string[] },
): { title: string; detail: string } | null {
  const lengthOf = (value: unknown) => (Array.isArray(value) ? value.length : 0);
  for (const { key, dimension, noun } of SCOPE_DIMENSIONS) {
    const own = lengthOf(widget.config[key]);
    const heldOnly = own > 0 ? false
      : heldBackCount(heldBack, 'widget', widget.id, dimension) > 0
        || onlyHeldBack(heldBack, 'dashboard', dashboardId, dimension, filterBar[key].length);
    if (heldOnly) {
      return {
        title: OUTSIDE_ACCESS_LABEL,
        detail: `This widget is filtered to ${noun} your Access does not include, so it has nothing to count for you. Add one of your ${noun} to its filter to count it.`,
      };
    }
  }
  return null;
}

const isHeldField = (field: string) => field === 'subscription' || field === 'resourceGroup' || field === 'resourceName' || isRowField(field);

/**
 * The query without the placeholder `OUTSIDE_ACCESS_LABEL` as a value of a Scope, resource name or returned
 * column, which only a copy sent out with every value of that dimension held back carries. It stands for
 * values the person was not sent and is never stored. A query without it is returned as it came.
 */
export function withoutPlaceholder(query: string): string {
  const view = viewFromSearchParams(new URLSearchParams(query));
  const carries = (f: { field: string; values: readonly string[] }) => isHeldField(f.field) && f.values.includes(OUTSIDE_ACCESS_LABEL);
  if (!view.filters.some(carries)) return query;
  const filters = view.filters
    .map(f => (carries(f) ? { ...f, values: f.values.filter(value => value !== OUTSIDE_ACCESS_LABEL) } : f))
    .filter(f => f.values.length > 0);
  return viewToSearchParams({ ...view, filters } as typeof view).toString();
}
