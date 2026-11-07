/**
 * The client-safe half of Saved views: the shape a saved view has, what may be saved, and how a
 * saved view's query is cleaned and turned back into a link. No database or Node imports, so the
 * explorer's menu and the server share one definition. Request validation lives with the server in
 * lib/saved-views.ts, and the repository in lib/db/saved-views.ts.
 *
 * A saved view stores the tab it opens on and the View's query string exactly as
 * `viewToSearchParams` writes it, so everything the /scans URL carries is saved without this module
 * knowing the View's shape.
 */
import { viewFromSearchParams, viewToSearchParams } from './finding-view';

export const SAVED_VIEW_TABS = ['results', 'advisories', 'activity'] as const;
export type SavedViewTab = (typeof SAVED_VIEW_TABS)[number];

export const MAX_SAVED_VIEW_QUERY_LENGTH = 4000;
export const MAX_SAVED_VIEW_NAME_LENGTH = 100;

/** The /scans param that records which saved view is open. `viewFromSearchParams` ignores it. */
export const OPEN_VIEW_PARAM = 'view';

/** What a person chooses when saving a view; the rest of a SavedView is bookkeeping. */
export interface SavedViewFields {
  name: string;
  tab: SavedViewTab;
  /** The View's query string as `viewToSearchParams` writes it, without `tab`. */
  query: string;
}

export interface SavedView extends SavedViewFields {
  id: string;
  createdBy: string | null;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
}

export function isSavedViewTab(value: unknown): value is SavedViewTab {
  return typeof value === 'string' && (SAVED_VIEW_TABS as readonly string[]).includes(value);
}

/** The query a View has once it is read and written back, so two spellings of one View are one
 *  query and anything the reader does not know (a stale `tab`, a hand-typed param) is dropped. */
export function normalizeViewQuery(query: string): string {
  return viewToSearchParams(viewFromSearchParams(new URLSearchParams(query))).toString();
}

/** The link that opens a saved view: its tab, the view's id, then its query, the same param order
 *  the explorer writes, so opening a view and then touching nothing leaves the URL as it was. */
export function savedViewHref(view: Pick<SavedView, 'id' | 'tab' | 'query'>, basePath = '/scans'): string {
  const params = new URLSearchParams({ tab: view.tab, [OPEN_VIEW_PARAM]: view.id });
  for (const [key, value] of new URLSearchParams(view.query)) params.append(key, value);
  return `${basePath}?${params.toString()}`;
}
