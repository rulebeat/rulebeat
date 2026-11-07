import type { SavedView, SavedViewFields } from '@/lib/saved-view-query';

export type SavedViewChange =
  | { kind: 'create'; fields: SavedViewFields }
  | { kind: 'update'; id: string; fields: Partial<SavedViewFields> }
  | { kind: 'delete'; id: string };

/** `view` is the stored view after a create or update, and null after a delete. */
export type SavedViewChangeOutcome = { ok: true; view: SavedView | null } | { ok: false; error: string };

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
        body: JSON.stringify(change.fields),
      }),
    });
    if (res.redirected) return { ok: false, error: FALLBACK };
    if (res.ok) return { ok: true, view: change.kind === 'delete' ? null : await res.json() as SavedView };
    // Only a refusal the person can act on (a name in use, a name too long) carries its own message.
    if (res.status === 400 || res.status === 409) {
      const body = await res.json().catch(() => null) as { error?: unknown } | null;
      if (typeof body?.error === 'string' && body.error.trim() !== '') return { ok: false, error: body.error };
    }
    if (res.status === 404) return { ok: false, error: 'This saved view no longer exists.' };
    if (res.status === 403) return { ok: false, error: 'Your role cannot change saved views.' };
    return { ok: false, error: FALLBACK };
  } catch {
    return { ok: false, error: FALLBACK };
  }
}

/** A view stored in the list: replaces the one with its id, or is added when there is none. */
export function upsertSavedView(views: SavedView[], view: SavedView): SavedView[] {
  return views.some(v => v.id === view.id) ? views.map(v => (v.id === view.id ? view : v)) : [...views, view];
}
