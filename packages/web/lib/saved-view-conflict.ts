/**
 * Comparing two Views part by part, for the two places a saved view shows what differs (ADR 0013): the
 * Changed marks beside "Update with current view", and the conflict notice's list of what moved under the
 * person when someone saved the view first. Pure and client-safe.
 */
import {
  BUILTIN_FIELDS, FIELD_LABEL, DEFAULT_SORT, filterValues, isRowField, rowPath, savedViewAddress, sameWindow,
  type View, type ViewField,
} from './finding-view';

const fieldLabel = (field: ViewField): string => (isRowField(field) ? `${rowPath(field)} (returned)` : FIELD_LABEL[field]);

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every(v => right.has(v));
};
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const sortOf = (view: View) => view.sort ?? DEFAULT_SORT;

/**
 * The parts of `current` that differ from `saved`, named as the explorer names them: each filtered field
 * (built-in ones in the explorer's order, then returned columns), then the search, the date window, the
 * columns, the sort, the grouping and the group order. The page is where the viewer is, not a part.
 */
export function differingParts(saved: View, current: View): string[] {
  const fields = new Set<ViewField>([...saved.filters, ...current.filters].map(f => f.field));
  const builtin = BUILTIN_FIELDS.filter(f => fields.has(f));
  const returned = [...fields].filter(isRowField);
  const parts = [...builtin, ...returned]
    .filter(field => !sameSet(filterValues(saved.filters, field), filterValues(current.filters, field)))
    .map(fieldLabel);
  if (saved.search !== current.search) parts.push('Search');
  if (!sameWindow(saved.window, current.window)) parts.push('Date window');
  if (!sameList(saved.columns, current.columns)) parts.push('Columns');
  if (sortOf(saved).field !== sortOf(current).field || sortOf(saved).dir !== sortOf(current).dir) parts.push('Sort');
  if (!sameList(saved.groupBy, current.groupBy)) parts.push('Grouping');
  if (saved.groupSort.by !== current.groupSort.by || saved.groupSort.dir !== current.groupSort.dir) parts.push('Group order');
  return parts;
}

/**
 * The parts the person sees differently because `newer` replaced `older` as the saved view, leaving out
 * the parts their `changes` set: their own value still wins there. Both saved views are read with the same
 * changes, so what differs is exactly what moved under them.
 */
export function movedParts(older: View, newer: View, changes: URLSearchParams): string[] {
  return differingParts(savedViewAddress(older).read(changes), savedViewAddress(newer).read(changes));
}

/** What the Changed mark beside "Update with current view" says, or null when nothing differs. */
export function changedMark(parts: readonly string[]): string | null {
  return parts.length > 0 ? `Changed: ${parts.join(', ')}` : null;
}

/** What the save dialog says when a view saved with one open left out values outside the person's access. */
export function droppedNotice(count: number): string {
  return `${count} ${count === 1 ? 'value outside your access was' : 'values outside your access were'} not saved.`;
}

/** The notice for a change the page picked up by reading: nothing was being saved, so nothing is asked of the person. */
export const SAVED_VIEW_RELOADED_NOTICE =
  'This saved view changed since you opened it. The filters and every number were reloaded. Your changes are still in the address.';
