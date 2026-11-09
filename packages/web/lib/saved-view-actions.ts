import { STALE_VIEW_MESSAGE } from '@/lib/held-back';
import type { HeldBackSavedView, SavedViewFields } from '@/lib/saved-view-query';

export type SavedViewChange =
  | { kind: 'create'; fields: SavedViewFields }
  /** `revision` and `opened` are the version and the query of the copy the person was sent: the server refuses the save
   *  when the view has moved on, and puts back the stored values that copy left out. */
  | { kind: 'update'; id: string; fields: Partial<SavedViewFields>; revision?: number; opened?: string }
  | { kind: 'delete'; id: string };

/** `view` is the stored view after a create or update, and null after a delete. */
export type SavedViewChangeOutcome = { ok: true; view: HeldBackSavedView | null } | { ok: false; error: string; /** The view changed since the copy this save was made from: the page offers a reload. */ stale?: true };

const FALLBACK = 'The change could not be saved. Try again.';

/**
 * Sends one create, update or delete and reports whether the server accepted it, in the same
 * contract as requestSuppress (lib/suppression-actions.ts): a non-2xx response, a thrown fetch and a
 * followed redirect (an expired session landing on /signin) all come back as a reported error.
 * fetchJson only reads, and drops the server's message, which a name clash needs to show.
 */
export async function requestSavedViewChange(
  change: SavedViewChange,
  fetchImpl: typeof fetch = fetch,
): Promise<SavedViewChangeOutcome> {
  const url = change.kind === 'create' ? '/api/views' : `/api/views/${encodeURIComponent(change.id)}`;
  try {
    const res = await fetchImpl(url, {
      method: change.kind === 'create' ? 'POST' : change.kind === 'update' ? 'PATCH' : 'DELETE',
      ...(change.kind !== 'delete' && {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(change.kind === 'update' ? { ...change.fields, revision: change.revision, opened: change.opened } : change.fields),
      }),
    });
    if (res.redirected) return { ok: false, error: FALLBACK };
    if (res.ok) return { ok: true, view: change.kind === 'delete' ? null : await res.json() as HeldBackSavedView };
    // Only a refusal the person can act on (a name in use, a name too long) carries its own message.
    if (res.status === 400 || res.status === 409) {
      const body = await res.json().catch(() => null) as { error?: unknown } | null;
      if (typeof body?.error === 'string' && body.error.trim() !== '') {
        return body.error === STALE_VIEW_MESSAGE ? { ok: false, error: body.error, stale: true } : { ok: false, error: body.error };
      }
    }
    if (res.status === 404) return { ok: false, error: 'This saved view no longer exists.' };
    if (res.status === 403) return { ok: false, error: 'Your role cannot change saved views.' };
    return { ok: false, error: FALLBACK };
  } catch {
    return { ok: false, error: FALLBACK };
  }
}

/**
 * Reads one view as the server holds it now. The reload notice after a stale save opens this copy: reloading the
 * address would bring back the query of the old copy, with the newest revision to save it over.
 */
export async function fetchCurrentSavedView(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; view: HeldBackSavedView } | { ok: false; gone: boolean }> {
  try {
    const res = await fetchImpl(`/api/views/${encodeURIComponent(id)}`);
    if (res.redirected) return { ok: false, gone: false };
    if (res.ok) return { ok: true, view: await res.json() as HeldBackSavedView };
    return { ok: false, gone: res.status === 404 };
  } catch {
    return { ok: false, gone: false };
  }
}

/** A view stored in the list: replaces the one with its id, or is added when there is none. */
export function upsertSavedView(views: HeldBackSavedView[], view: HeldBackSavedView): HeldBackSavedView[] {
  return views.some(v => v.id === view.id) ? views.map(v => (v.id === view.id ? view : v)) : [...views, view];
}

/**
 * The copy a later save is based on, after our own share or unshare. The server answers with only the id,
 * visibility and revision. When that revision is the very next one, nothing else changed in between and the
 * base moves on; otherwise someone else wrote too, so the base stays and the next save is refused as stale.
 */
export function baseCopyAfterVisibilityChange(base: HeldBackSavedView, changed: Pick<HeldBackSavedView, 'visibility' | 'revision'>): HeldBackSavedView {
  return changed.revision === base.revision + 1 ? { ...base, visibility: changed.visibility, revision: changed.revision } : base;
}
