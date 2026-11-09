import { SAVED_VIEW_UNAVAILABLE, type SavedView, type SavedViewFields, type SavedViewTab } from '@/lib/saved-view-query';

export type SavedViewChange =
  /** A view saved with none open: the whole View's query, as always. */
  | { kind: 'create'; fields: SavedViewFields }
  /** A view saved with one open: the server builds it from the open view and the address's `changes`. */
  | { kind: 'create-from-open'; name: string; tab: SavedViewTab; fromView: string; revision: number; changes: string }
  /** A rename, the address's `changes` over the saved query ("Update with current view"), or both, over `revision`. */
  | { kind: 'update'; id: string; revision: number; name?: string; changes?: string }
  | { kind: 'delete'; id: string };

/** Someone saved first: the view as it is now, and who changed it and when, when the server knows. */
export interface SavedViewConflict { view: SavedView; changedBy?: string; changedAt?: string }

/** `view` is the stored view after a create or update, and null after a delete. `dropped` is how many
 *  values outside the person's access a view saved with one open left out. */
export type SavedViewChangeOutcome =
  | { ok: true; view: SavedView | null; dropped?: number }
  /** `outside` is how many values outside the person's access to remove, when that is why it was refused. */
  | { ok: false; error: string; conflict?: SavedViewConflict; outside?: number };

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
  const url = change.kind === 'create' || change.kind === 'create-from-open' ? '/api/views' : `/api/views/${encodeURIComponent(change.id)}`;
  try {
    const res = await fetchImpl(url, {
      method: change.kind === 'delete' ? 'DELETE' : change.kind === 'update' ? 'PATCH' : 'POST',
      ...(change.kind !== 'delete' && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyOf(change)) }),
    });
    if (res.redirected) return { ok: false, error: FALLBACK };
    if (res.ok) {
      if (change.kind === 'delete') return { ok: true, view: null };
      const { dropped, ...view } = await res.json() as SavedView & { dropped?: number };
      return { ok: true, view, ...(typeof dropped === 'number' && { dropped }) };
    }
    // Only a refusal the person can act on (a name in use, a name too long, a stale revision, a value
    // outside their access) carries its own message.
    if (res.status === 400 || res.status === 409 || res.status === 422) {
      const body = await res.json().catch(() => null) as Record<string, unknown> | null;
      if (typeof body?.error === 'string' && body.error.trim() !== '') {
        const conflict = res.status === 409 && isStoredView(body.view)
          ? { view: body.view, ...(typeof body.changedBy === 'string' && { changedBy: body.changedBy }), ...(typeof body.changedAt === 'string' && { changedAt: body.changedAt }) }
          : undefined;
        return {
          ok: false, error: body.error,
          ...(conflict && { conflict }),
          ...(res.status === 422 && body.code === 'outside-access' && typeof body.count === 'number' && { outside: body.count }),
        };
      }
    }
    if (res.status === 404) return { ok: false, error: change.kind === 'create-from-open' ? SAVED_VIEW_UNAVAILABLE : 'This saved view no longer exists.' };
    if (res.status === 403) return { ok: false, error: 'Your role cannot change saved views.' };
    return { ok: false, error: FALLBACK };
  } catch {
    return { ok: false, error: FALLBACK };
  }
}

function bodyOf(change: Exclude<SavedViewChange, { kind: 'delete' }>): object {
  switch (change.kind) {
    case 'create': return change.fields;
    case 'create-from-open': return { name: change.name, tab: change.tab, fromView: change.fromView, revision: change.revision, changes: change.changes };
    case 'update': return {
      revision: change.revision,
      ...(change.name !== undefined && { name: change.name }),
      ...(change.changes !== undefined && { changes: change.changes }),
    };
  }
}

function isStoredView(value: unknown): value is SavedView {
  const view = value as Partial<SavedView> | null;
  return typeof view === 'object' && view !== null && typeof view.id === 'string' && typeof view.query === 'string' && typeof view.revision === 'number';
}

/** A view stored in the list: replaces the one with its id, or is added when there is none. */
export function upsertSavedView(views: SavedView[], view: SavedView): SavedView[] {
  return views.some(v => v.id === view.id) ? views.map(v => (v.id === view.id ? view : v)) : [...views, view];
}
