import type { ItemKind } from '@/lib/item-access-model';
import { STALE_DASHBOARD_MESSAGE, STALE_VIEW_MESSAGE } from '@/lib/held-back';

/** `item` is what the route answered with: the item itself, or just its id and visibility after someone else's unshare. */
export type VisibilityChangeOutcome = { ok: true; item: unknown } | { ok: false; error: string };

const FALLBACK = 'The change could not be saved. Try again.';

const PATH: Record<ItemKind, string> = { dashboard: 'dashboards', view: 'views' };
const NOUN: Record<ItemKind, string> = { dashboard: 'dashboard', view: 'saved view' };

/**
 * Sends one share or unshare and reports whether the server accepted it, in the same contract as
 * `requestSavedViewChange`: a refusal the person can act on (a name in use, a changed state, a widget on a view that is no longer shared) shows the server's
 * message, and anything else (a failure, a followed redirect to /signin, a thrown fetch) gets a fixed one.
 */
export async function requestVisibilityChange(
  kind: ItemKind,
  id: string,
  action: 'share' | 'unshare',
  fetchImpl: typeof fetch = fetch,
): Promise<VisibilityChangeOutcome> {
  try {
    const res = await fetchImpl(`/api/${PATH[kind]}/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    if (res.redirected) return { ok: false, error: FALLBACK };
    if (res.ok) return { ok: true, item: await res.json() };
    if (res.status === 409 || res.status === 400) {
      const body = await res.json().catch(() => null) as { error?: unknown } | null;
      if (typeof body?.error === 'string' && body.error.trim() !== '') return { ok: false, error: body.error };
    }
    if (res.status === 404) return { ok: false, error: `This ${NOUN[kind]} no longer exists.` };
    if (res.status === 403) return { ok: false, error: `Your access does not let you ${action} this.` };
    return { ok: false, error: FALLBACK };
  } catch {
    return { ok: false, error: FALLBACK };
  }
}

export type RemoveHeldBackOutcome =
  /** `item` is the dashboard or saved view as the server holds it now, with the values gone. */
  | { ok: true; item: unknown }
  /** `stale`: the item changed since the copy the count was read from, so the page offers a reload. */
  | { ok: false; error: string; stale?: true };

/**
 * Sends "Remove N values" for an item, on the revision of the copy the person saw the count on, and reports it in the
 * same contract as `requestVisibilityChange`: the server's words for a stale copy, fixed ones for anything else.
 */
export async function requestRemoveHeldBack(
  kind: ItemKind,
  id: string,
  revision: number,
  fetchImpl: typeof fetch = fetch,
): Promise<RemoveHeldBackOutcome> {
  try {
    const res = await fetchImpl(`/api/${PATH[kind]}/${encodeURIComponent(id)}/remove-held-back`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision }),
    });
    if (res.redirected) return { ok: false, error: FALLBACK };
    if (res.ok) return { ok: true, item: await res.json() };
    const body = await res.json().catch(() => null) as { error?: unknown } | null;
    const message = typeof body?.error === 'string' && body.error.trim() !== '' ? body.error : null;
    if (res.status === 409 && message === (kind === 'dashboard' ? STALE_DASHBOARD_MESSAGE : STALE_VIEW_MESSAGE)) return { ok: false, error: message, stale: true };
    if ((res.status === 409 || res.status === 400) && message) return { ok: false, error: message };
    if (res.status === 404) return { ok: false, error: `This ${NOUN[kind]} no longer exists.` };
    if (res.status === 403) return { ok: false, error: `Your access does not let you change this ${NOUN[kind]}.` };
    return { ok: false, error: FALLBACK };
  } catch {
    return { ok: false, error: FALLBACK };
  }
}
