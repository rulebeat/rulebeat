import type { ItemKind } from '@/lib/item-access-model';
import type { VisibilityChangeOutcome } from '@/lib/item-sharing-client';

/** One person a Shared item can be handed to: what the picker shows, and nothing of their Roles or Scopes. */
export interface HandOverPerson { id: string; displayName: string; email: string }

export type CandidatesOutcome = { ok: true; people: HandOverPerson[] } | { ok: false; error: string };

const FALLBACK = 'The change could not be saved. Try again.';
const LIST_FALLBACK = 'The list of people could not be loaded. Try again.';

const PATH: Record<ItemKind, string> = { dashboard: 'dashboards', view: 'views' };
const NOUN: Record<ItemKind, string> = { dashboard: 'dashboard', view: 'saved view' };

/** The message for a refusal the person can act on (the server's own for a 400 or 409), else a fixed one. */
async function refusal(res: Response, kind: ItemKind, verb: 'hand' | 'take', fallback: string): Promise<string> {
  if (res.status === 400 || res.status === 409) {
    const body = await res.json().catch(() => null) as { error?: unknown } | null;
    if (typeof body?.error === 'string' && body.error.trim() !== '') return body.error;
  }
  if (res.status === 404) return `This ${NOUN[kind]} no longer exists.`;
  if (res.status === 403) return `Your access does not let you ${verb} this over.`;
  return fallback;
}

/** The people a Shared item can be handed to, as the server lists them. */
export async function fetchHandOverCandidates(kind: ItemKind, id: string, fetchImpl: typeof fetch = fetch): Promise<CandidatesOutcome> {
  try {
    const res = await fetchImpl(`/api/${PATH[kind]}/${encodeURIComponent(id)}/hand-over-candidates`);
    if (res.redirected) return { ok: false, error: LIST_FALLBACK };
    if (res.ok) return { ok: true, people: await res.json() as HandOverPerson[] };
    return { ok: false, error: await refusal(res, kind, 'hand', LIST_FALLBACK) };
  } catch {
    return { ok: false, error: LIST_FALLBACK };
  }
}

async function send(kind: ItemKind, id: string, action: 'hand-over' | 'take-over', init: RequestInit, fetchImpl: typeof fetch): Promise<VisibilityChangeOutcome> {
  try {
    const res = await fetchImpl(`/api/${PATH[kind]}/${encodeURIComponent(id)}/${action}`, { method: 'POST', ...init });
    if (res.redirected) return { ok: false, error: FALLBACK };
    if (res.ok) return { ok: true, item: await res.json() };
    return { ok: false, error: await refusal(res, kind, action === 'hand-over' ? 'hand' : 'take', FALLBACK) };
  } catch {
    return { ok: false, error: FALLBACK };
  }
}

/** Hands a Shared item to the chosen person, in the same contract as `requestVisibilityChange`. */
export function requestHandOver(kind: ItemKind, id: string, userId: string, fetchImpl: typeof fetch = fetch): Promise<VisibilityChangeOutcome> {
  return send(kind, id, 'hand-over', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) }, fetchImpl);
}

/** Makes the person the owner of a Shared item. */
export function requestTakeOver(kind: ItemKind, id: string, fetchImpl: typeof fetch = fetch): Promise<VisibilityChangeOutcome> {
  return send(kind, id, 'take-over', {}, fetchImpl);
}
