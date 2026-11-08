import type { ItemKind } from '@/lib/item-access-model';

/** `item` is what the route answered with: the item itself, or just its id and visibility after someone else's unshare. */
export type VisibilityChangeOutcome = { ok: true; item: unknown } | { ok: false; error: string };

const FALLBACK = 'The change could not be saved. Try again.';

const PATH: Record<ItemKind, string> = { dashboard: 'dashboards', view: 'views' };
const NOUN: Record<ItemKind, string> = { dashboard: 'dashboard', view: 'saved view' };

/**
 * Sends one share or unshare and reports whether the server accepted it, in the same contract as
 * `requestSavedViewChange`: a refusal the person can act on (a name in use, a changed state) shows the server's
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
    if (res.status === 409) {
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
