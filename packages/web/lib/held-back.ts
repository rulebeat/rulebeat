/**
 * Held-back values (#363, ADR 0012): a stored filter value outside the viewer's Access. A dashboard or a
 * saved view is shared, so it can name a subscription, a resource group, a resource or a returned-column
 * value the viewer cannot see. The server never sends such a value. It sends the item without it and one
 * count per place and dimension, and the page says "N outside your access" where the values would be.
 *
 * This is the client-safe half: the label, the shape of a count and the words and lookups the components
 * share. What decides which values are held back, a findings query included, is lib/db/held-back.ts.
 */

/** What a chip, a select or an empty widget reads in place of a value outside the person's Access. */
export const OUTSIDE_ACCESS_LABEL = 'Outside your access';

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
        detail: `This widget is filtered to ${noun} your Access does not include, so it has nothing to count for you. Clear the filter to see your own.`,
      };
    }
  }
  return null;
}
