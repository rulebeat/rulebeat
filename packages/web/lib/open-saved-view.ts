/**
 * The saved view a Scans read has open (#373, ADR 0012). The address holds `view=<id>` and only the filter
 * values its reader can see; the values the view stores that are held back from them never leave the server.
 * So every findings read and the export loads the stored view and adds those values back before it matches,
 * which makes a dimension held back in full match nothing for the reader instead of widening to their whole
 * Access. Only closing the view on Scans widens.
 *
 * A view that does not open (deleted, or someone else's Personal view, an Admin's included) is the same answer
 * either way: the read flags it and goes on with the address filters alone.
 */
import type { ItemActor } from './item-access';
import { canOpenItem } from './item-access';
import { viewFromSearchParams, viewToSearchParams, type View } from './finding-view';
import { OPEN_VIEW_PARAM } from './saved-view-query';
import { restoreHeldBackView } from './db/held-back';
import { getSavedView } from './db/saved-views';

/** The header the export answers with in place of the flag its body has no room for. */
export const VIEW_MISSING_HEADER = 'X-View-Missing';

export interface OpenViewRead {
  /** The View to match: the address's, plus the open view's values held back from the reader. */
  view: View;
  /** The address's own View, which is what the reader sees and what anything echoed back is marked from. */
  address: View;
  /** `view=<id>` named a view that does not open for this reader. */
  viewMissing: boolean;
}

/** The View a read matches, from its address and the saved view the address says is open, if any. */
export async function readWithOpenView(actor: ItemActor, params: URLSearchParams, address: View): Promise<OpenViewRead> {
  const id = params.get(OPEN_VIEW_PARAM);
  if (!id) return { view: address, address, viewMissing: false };

  const stored = await getSavedView(id);
  if (!stored || !canOpenItem(actor, stored)) return { view: address, address, viewMissing: true };

  // Without a copy the reader was sent to measure against, only what is held back from them now goes back,
  // which is what a read wants: whatever the address dropped or kept of the visible values is theirs.
  const merged = await restoreHeldBackView(actor.access, stored, viewToSearchParams(address).toString());
  const { filters } = viewFromSearchParams(new URLSearchParams(merged.query));
  return { view: { ...address, filters }, address, viewMissing: false };
}

/** A JSON answer with the flag added when the view did not open. */
export function withViewFlag<T extends object>(body: T, viewMissing: boolean): T & { viewMissing?: true } {
  return viewMissing ? { ...body, viewMissing: true } : body;
}
