/**
 * What the explorer decides to draw, as functions of what the session holds, so each decision can be
 * tested without rendering anything: which screen it shows, what stands in for the list, when a
 * group reads its contents, and what a dropdown of values shows. The components draw the answers.
 * A failed read comes before an empty one in every decision, so a failure is never drawn as "no
 * findings". Client-safe: no Node, no database.
 */
import { groupUrl, type Loaded, type ViewRequest } from './explorer-session';
import { NO_VALUE_LABEL, type ColumnValuesResponse, type ViewResponse } from './view-response';

// ---- The screen ----

export type ExplorerScreen = 'widget-unavailable' | 'unavailable' | 'loading' | 'empty' | 'explorer';

/** Which screen the explorer shows. `data` is the answer on screen (the last one while the next is on
 *  its way), `failure` the message of a failed read. A failed read with no earlier answer has nothing
 *  else to draw; with one, the controls stay and the list is where the failure shows. The empty screen
 *  is for a tab where no rule has a finding at all, which is not the same as filters matching none. */
export function screenOf(state: {
  mode: 'page' | 'widget';
  suppressionsFailed: boolean;
  failure: string | null;
  data: Pick<ViewResponse, 'policyOptions'> | null;
}): ExplorerScreen {
  // Only the widget loads its own suppressions, and a failed load must not read as "no suppressions".
  if (state.mode === 'widget' && state.suppressionsFailed) return 'widget-unavailable';
  if (state.failure && !state.data) return 'unavailable';
  if (!state.data) return 'loading';
  if (state.data.policyOptions.length === 0) return 'empty';
  return 'explorer';
}

// ---- The list ----

export type ListBody = 'unavailable' | 'empty' | 'rows';

/** What fills the list's place: the failure, a message that nothing matches, or the rows. The By rule
 *  list is empty by its rule rows, a grouped list by its groups, and a flat one by its findings. */
export function listBodyOf(state: {
  layout: 'rule' | 'resource';
  failure: string | null;
  ruleRows: number;
  grouped: { groupTotal: number } | null;
  items: number;
}): ListBody {
  if (state.failure) return 'unavailable';
  const count = state.layout === 'rule' ? state.ruleRows : state.grouped ? state.grouped.groupTotal : state.items;
  return count === 0 ? 'empty' : 'rows';
}

// ---- A group ----

/** What a group reads: its contents at `page` once it is open, and nothing while it is closed. */
export function openGroupUrl(open: boolean, request: ViewRequest, valuesPath: readonly (string | null)[], page: number): string | null {
  return open ? groupUrl(request, valuesPath, page) : null;
}

// ---- A dropdown of values ----

export interface ValueOption { value: string; label: string; count?: number }

/** The values the server sent for a returned column, the empty value named. In the order sent. */
export function valueOptionsOf(loaded: ColumnValuesResponse | null): ValueOption[] {
  return (loaded?.values ?? []).map(v => ({ value: v.value, label: v.value === '' ? NO_VALUE_LABEL : v.value, count: v.count }));
}

export type ValuesPanelBody = 'loading' | 'failed' | 'empty' | 'options';

/** What a dropdown's panel shows. A panel of a returned column (`remote`) lists what the server sent for
 *  the text typed, which the server has already narrowed, and is loading until it has that. Any other
 *  panel narrows its own `options` by the text. `footer` says when the server holds more values than it
 *  sent. */
export function valuesPanelOf(state: {
  remote: boolean;
  read: Loaded<ColumnValuesResponse> | undefined;
  options: readonly ValueOption[];
  search: string;
}): { body: ValuesPanelBody; options: ValueOption[]; failure: string | null; footer: string | null } {
  const { remote, read, search } = state;
  const loaded = read?.status === 'ready' ? read.data : null;
  const shown = remote ? valueOptionsOf(loaded) : [...state.options];
  const options = !remote && search ? shown.filter(o => o.label.toLowerCase().includes(search.toLowerCase())) : shown;
  const footer = loaded && loaded.total > loaded.values.length
    ? `Showing ${loaded.values.length} of ${loaded.total}. Search to narrow the list.`
    : null;
  if (remote && (!read || read.status === 'loading')) return { body: 'loading', options, failure: null, footer };
  if (read?.status === 'failed') return { body: 'failed', options, failure: read.message, footer };
  return { body: options.length === 0 ? 'empty' : 'options', options, failure: null, footer };
}
