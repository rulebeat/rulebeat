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
  | { ok: true; scope: string[] | undefined; scopeSet: string | undefined; leftOut?: string[] }
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
 * The server refuses a set naming a Scope the sender holds no part of, so a set leaves out the picks in `unheld`,
 * those the server has answered for as wholly outside the Access. A pick held in part is sent, since it applies as
 * the part held inline and in a set alike. A pick no answer has described yet (one just ticked) is sent, and the
 * server's refusal is the answer if it was not held. Leaving a pick out cannot widen the view, since a pick the
 * viewer holds none of matches nothing for them, and `leftOut` names what was dropped so the page can say so. A
 * list with no held pick is sent as it is.
 */
export async function commitScopePicks(
  picks: readonly string[], create: (paths: string[]) => Promise<ScopeSetReply> = paths => requestScopeSet(paths),
  unheld?: ReadonlySet<string>,
): Promise<ScopeWrite> {
  if (picks.length === 0) return { ok: true, scope: undefined, scopeSet: undefined };
  const list = [...picks];
  if (!encodeView({ ...emptyView(), scope: list }).needsScopeSet) return { ok: true, scope: list, scopeSet: undefined };
  const heldPicks = unheld ? list.filter(pick => !unheld.has(pick.toLowerCase())) : list;
  if (heldPicks.length === 0) {
    const reply = await create(list);
    return reply.ok ? { ok: true, scope: undefined, scopeSet: reply.hash } : reply;
  }
  const reply = await create(heldPicks);
  if (!reply.ok) return reply;
  const leftOut = list.filter(pick => !heldPicks.includes(pick));
  return { ok: true, scope: undefined, scopeSet: reply.hash, ...(leftOut.length > 0 ? { leftOut } : {}) };
}

/** What the page says when a set was made without some picks, or null when it holds them all. */
export function leftOutMessage(leftOut: readonly string[] | undefined): string | null {
  if (!leftOut || leftOut.length === 0) return null;
  return leftOut.length === 1
    ? '1 pick outside your access was left out of the saved list.'
    : `${leftOut.length} picks outside your access were left out of the saved list.`;
}

/**
 * The picks being edited. A list that travels as a set is not on the page: the server opened it and its states
 * name each pick the viewer holds, so they are read from there, every one, so removing a pick never drops the
 * others and widens the view. The picks the server hid from the viewer match nothing or only a part they hold, and
 * editing the set writes a new one without them.
 */
export function currentScopePicks(scope: readonly string[] | undefined, scopeSet: string | undefined, states: readonly ScopePickState[]): string[] {
  if (scopeSet) return states.map(s => s.value);
  return [...(scope ?? [])];
}

/** The lower-case paths of the picks the viewer holds no part of: what a set leaves out. */
export function unheldPickPaths(states: readonly ScopePickState[]): Set<string> {
  return new Set(states.filter(s => s.access === 'outside').map(s => s.value.toLowerCase()));
}
