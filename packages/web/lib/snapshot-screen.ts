/**
 * What the snapshot screen decides to draw and where it points (ADR 0008), as functions of what the
 * session holds, so each decision can be tested without rendering anything. A failed read comes before
 * an empty one, so a failure is never drawn as a run with no findings. Client-safe: no Node, no database.
 */
import { viewToSearchParams, emptyView, type View } from './finding-view';
import type { ExportFormat } from './findings-export';
import type { SnapshotState } from './snapshot-session';
import { snapshotQueryToParams, type SnapshotQuery } from './snapshot-query';
import { EXPLORER_SEVERITIES } from './explorer-filters';
import type { SnapshotFacetValue, SnapshotItem, SnapshotResponse } from './snapshot-response';

/** The one line the snapshot says about what it does not hold. */
export const LIVE_FINDING_NOTE = 'A past run keeps each finding as it was found, not its rows or its status. Rows and status are on the live finding: open one to see them.';

/** How far back a link to a live finding reaches for a finding that was fixed, in days: ten years, so a
 *  fixed finding is listed however long ago it was. */
const LIVE_LINK_WINDOW_DAYS = 3650;

const route = (scanId: string) => `/api/scans/${encodeURIComponent(scanId)}/snapshot`;

/** The read of one page of a snapshot. The query string is the address's own `snapshotQueryToParams`. */
export function snapshotUrl(scanId: string, query: SnapshotQuery): string {
  const params = snapshotQueryToParams(query).toString();
  return params === '' ? route(scanId) : `${route(scanId)}?${params}`;
}

/** The file of every finding the filters and the search match. A file has no page. */
export function snapshotExportUrl(scanId: string, query: SnapshotQuery, format: ExportFormat): string {
  return `${route(scanId)}/export?${snapshotQueryToParams({ ...query, page: 1 }, new URLSearchParams({ format }))}`;
}

/** Where the live finding of a snapshot finding is: its own tab, narrowed to its rule and its resource,
 *  with every status listed and a window wide enough to reach a fixed one. None when the finding no
 *  longer exists. The explorer's search is a contains match, so a resource id that is the start of
 *  another's lists both, and the one wanted is the first of them in the explorer's own order. */
export function liveFindingHref(item: SnapshotItem): string | null {
  if (!item.exists) return null;
  const view: View = {
    ...emptyView(),
    filters: [{ field: 'rule', values: [item.ruleId] }, { field: 'status', values: ['all'] }],
    window: { mode: 'relative', days: LIVE_LINK_WINDOW_DAYS },
    search: item.resourceId ?? item.resourceName ?? '',
  };
  return `/scans?${viewToSearchParams(view, { tab: item.tab })}`;
}

// ---- The filters ----

export interface SnapshotOption { value: string; label: string; count: number }

const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The options of a filter dropdown: the facet's values with their counts, in the order sent, then any
 *  chosen value the other filters leave no match for (count none), so a choice never disappears from the
 *  list that holds it. */
export function snapshotFacetOptions(
  facet: readonly SnapshotFacetValue[], selected: readonly string[], kind: 'severity' | 'rule',
): SnapshotOption[] {
  const label = (text: string) => (kind === 'severity' ? capitalised(text) : text);
  const options = facet.map(v => ({ value: v.value, label: label(v.label), count: v.count }));
  const listed = new Set(facet.map(v => v.value));
  for (const value of selected) if (!listed.has(value)) options.push({ value, label: label(value), count: 0 });
  return options;
}

type Chosen = 'severity' | 'rule';

/** The query with `value` chosen or unchosen on a filter, back on the first page. */
export function toggledSnapshotQuery(query: SnapshotQuery, filter: Chosen, value: string): SnapshotQuery {
  const chosen = new Set(query[filter]);
  if (!chosen.delete(value)) chosen.add(value);
  const next = filter === 'severity' ? EXPLORER_SEVERITIES.filter(s => chosen.has(s)) : [...chosen];
  return { ...query, [filter]: next, page: 1 };
}

export function clearedSnapshotQuery(query: SnapshotQuery, filter: Chosen): SnapshotQuery {
  return { ...query, [filter]: [], page: 1 };
}

export function searchedSnapshotQuery(query: SnapshotQuery, search: string): SnapshotQuery {
  return { ...query, search, page: 1 };
}

// ---- The screen ----

export type SnapshotScreen = 'loading' | 'unavailable' | 'not-found' | 'no-records' | 'empty-run' | 'no-match' | 'rows';

export interface SnapshotScreenInput {
  state: SnapshotState;
  /** What the screen asks for, to tell a run with no findings from filters that match none. */
  query: SnapshotQuery;
}

export const isSnapshotFiltered = (query: SnapshotQuery) => query.severity.length > 0 || query.rule.length > 0 || query.search !== '';

/** The answer on screen: the last one while the next is on its way, and after a failed read, so the
 *  filters stay on screen to change the request. */
export function snapshotDataOf(state: SnapshotState): SnapshotResponse | undefined {
  return state.status === 'ready' ? state.data : state.status === 'loading' || state.status === 'failed' ? state.stale : undefined;
}

/** Which of the seven screens the snapshot shows. */
export function snapshotScreenOf({ state, query }: SnapshotScreenInput): SnapshotScreen {
  if (state.status === 'failed') return 'unavailable';
  if (state.status === 'not-found') return 'not-found';
  if (state.status === 'no-records') return 'no-records';
  const data = snapshotDataOf(state);
  if (!data) return 'loading';
  if (data.total === 0) return isSnapshotFiltered(query) ? 'no-match' : 'empty-run';
  return 'rows';
}
