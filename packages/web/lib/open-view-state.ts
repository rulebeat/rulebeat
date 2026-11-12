/**
 * What the Scans page holds about the saved view its address names (#373, ADR 0012), as functions of the state
 * so each decision can be tested without rendering: the view stays open until the viewer closes it or a read
 * says it no longer opens, and a view that no longer opens is announced once. Client-safe.
 */

export interface OpenViewState {
  /** The view the address names that this page has let go of, whether the viewer closed it or it did not open. */
  droppedId: string | null;
  /** The "This saved view no longer exists." notice is showing. */
  gone: boolean;
}

export const OPEN_VIEW_INITIAL: OpenViewState = { droppedId: null, gone: false };

/** The view the page has open: the one the address names, unless it has been let go of. */
export function openViewIdOf(addressId: string | null | undefined, state: OpenViewState): string | null {
  return addressId && addressId !== state.droppedId ? addressId : null;
}

/** The state once a read has answered for the open view. A view the read says does not open is dropped and
 *  announced; any other answer changes nothing, so the notice is raised once per view. */
export function afterRead(state: OpenViewState, openId: string | null, viewMissing: boolean): OpenViewState {
  if (!viewMissing || !openId) return state;
  return { droppedId: openId, gone: true };
}

/** The state once the viewer closes the open view: dropped, with no notice. */
export function afterClose(state: OpenViewState, openId: string | null): OpenViewState {
  return openId ? { ...state, droppedId: openId } : state;
}

/** The state once the viewer dismisses the notice. */
export function afterDismiss(state: OpenViewState): OpenViewState {
  return state.gone ? { ...state, gone: false } : state;
}
