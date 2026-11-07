/**
 * How the Scans page writes the Scope picks it holds (#388, ADR 0016). A short list is written inline as
 * `scope=`; one over `SCOPE_INLINE_BUDGET` is sent to `POST /api/scope-sets` and only the hash it answers with is
 * kept, so no request the page makes ever carries the list. Until the server has answered, the filter is the one
 * it was: a list is never dropped for being too long to write, which would widen the view. Client-safe.
 */
import { emptyView, encodeView } from './finding-view';
import type { ScopePickState } from './filter-states';

export type ScopeSetReply = { ok: true; hash: string } | { ok: false; message: string };

export type ScopeWrite =
  | { ok: true; scope: string[] | undefined; scopeSet: string | undefined }
  | { ok: false; message: string };

export const SCOPE_SET_FAILED_MESSAGE = 'Could not save this list of Scopes. Try again.';

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<Response>;

/** Asks the server to store the list and answer with its own hash for it. */
export async function requestScopeSet(paths: readonly string[], fetchFn: FetchFn = (url, init) => fetch(url, init)): Promise<ScopeSetReply> {
  try {
    const res = await fetchFn('/api/scope-sets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }) });
    const body = await res.json() as { hash?: unknown; error?: unknown };
    if (res.ok && typeof body.hash === 'string') return { ok: true, hash: body.hash };
    return { ok: false, message: typeof body.error === 'string' && body.error !== '' ? body.error : SCOPE_SET_FAILED_MESSAGE };
  } catch {
    return { ok: false, message: SCOPE_SET_FAILED_MESSAGE };
  }
}

/**
 * The state to hold for `picks`: the list itself while it fits in an address, otherwise the hash of its set.
 * The server refuses a set naming a Scope the sender does not hold in full, so a set is made of `held` picks alone
 * when some are given. That cannot widen the view, since a pick the viewer holds none of matches nothing for them;
 * a list with no held pick is sent as it is and the server's refusal is the answer.
 */
export async function commitScopePicks(
  picks: readonly string[], create: (paths: string[]) => Promise<ScopeSetReply> = paths => requestScopeSet(paths),
  held?: ReadonlySet<string>,
): Promise<ScopeWrite> {
  if (picks.length === 0) return { ok: true, scope: undefined, scopeSet: undefined };
  const list = [...picks];
  if (!encodeView({ ...emptyView(), scope: list }).needsScopeSet) return { ok: true, scope: list, scopeSet: undefined };
  const heldPicks = held ? list.filter(pick => held.has(pick.toLowerCase())) : list;
  const reply = await create(heldPicks.length > 0 ? heldPicks : list);
  return reply.ok ? { ok: true, scope: undefined, scopeSet: reply.hash } : reply;
}

/**
 * The picks being edited. A list that travels as a set is not on the page: the server opened it and its states
 * name each pick, so they are read from there, every one, so removing a pick never drops the others and widens the view.
 */
export function currentScopePicks(scope: readonly string[] | undefined, scopeSet: string | undefined, states: readonly ScopePickState[]): string[] {
  if (scopeSet) return states.map(s => s.value);
  return [...(scope ?? [])];
}

/** The lower-case paths of the picks the viewer holds in full: what a set may be made of. */
export function heldPickPaths(states: readonly ScopePickState[]): Set<string> {
  return new Set(states.filter(s => s.access === 'held').map(s => s.value.toLowerCase()));
}
