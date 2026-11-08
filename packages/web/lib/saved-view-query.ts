/**
 * The client-safe half of Saved views: the shape a saved view has, what may be saved, and how a
 * saved view's query is cleaned and turned back into a link. No database or Node imports, so the
 * explorer's menu and the server share one definition. Request validation lives with the server in
 * lib/saved-views.ts, and the repository in lib/db/saved-views.ts.
 *
 * A saved view stores the tab it opens on and the View's query string exactly as
 * `viewToSearchParams` writes it, so everything the /scans URL carries is saved without this module
 * knowing the View's shape. With a view open, the address carries only the differences from that
 * query (`savedViewAddress` in lib/finding-view.ts).
 */
import { viewFromSearchParams, viewToSearchParams, type View } from './finding-view';

export const SAVED_VIEW_TABS = ['results', 'advisories', 'activity'] as const;
export type SavedViewTab = (typeof SAVED_VIEW_TABS)[number];

export const MAX_SAVED_VIEW_QUERY_LENGTH = 4000;
export const MAX_SAVED_VIEW_NAME_LENGTH = 100;

/** The /scans param that records which saved view is open. `viewFromSearchParams` ignores it. */
export const OPEN_VIEW_PARAM = 'view';

/** The param that carries the revision of the open saved view on a read, so the server can tell the
 *  view the page was opened on from the one it holds now. */
export const OPEN_VIEW_REVISION_PARAM = 'rev';

/** The saved view an address has open: its id and revision, and the View it saved. The address
 *  carries only differences from `view`, and the server puts the two back together. */
export interface OpenSavedView { id: string; revision: number; view: View }

/** What a link to a saved view that is unknown, deleted or not the person's to open says. One message
 *  for all three, so none can be told from another. */
export const SAVED_VIEW_UNAVAILABLE = 'This saved view is not available to you';

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
  /** Starts at 1; every write to the row bumps it. */
  revision: number;
}

export function isSavedViewTab(value: unknown): value is SavedViewTab {
  return typeof value === 'string' && (SAVED_VIEW_TABS as readonly string[]).includes(value);
}

/** The query a View has once it is read and written back, so two spellings of one View are one
 *  query and anything the reader does not know (a stale `tab`, a hand-typed param) is dropped. The
 *  page is where the viewer happens to be, not part of what they set up, so it is dropped too. */
export function normalizeViewQuery(query: string): string {
  return viewToSearchParams({ ...viewFromSearchParams(new URLSearchParams(query)), page: 1 }).toString();
}

/** The link that opens a saved view: its tab and its id, nothing else. The view's query is read from
 *  the view, so the link follows a later update of it, and the explorer's address then carries only
 *  what the viewer changes on top of it (`savedViewAddress`). */
export function savedViewHref(view: Pick<SavedView, 'id' | 'tab'>, basePath = '/scans'): string {
  return `${basePath}?${new URLSearchParams({ tab: view.tab, [OPEN_VIEW_PARAM]: view.id }).toString()}`;
}
