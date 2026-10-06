import { fetchJson, type FetchResult } from '@/lib/fetch-json';
import type { Suppression } from '@/lib/types';

export type SuppressOutcome = { ok: true; suppression: Suppression } | { ok: false; error: string };
export type UnsuppressOutcome = { ok: true; id: string } | { ok: false; error: string };

const SUPPRESS_FALLBACK = 'Could not suppress this finding. The change was not saved.';
const UNSUPPRESS_FALLBACK = 'Could not remove the suppression. The change was not saved.';

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({})) as { error?: unknown };
  return typeof body.error === 'string' && body.error.trim() !== '' ? body.error : fallback;
}

/**
 * Sends a suppress request and reports whether the server accepted it, mirroring
 * requestRuleToggle's contract (lib/rule-toggle.ts): only an accepted change comes back `ok`, so
 * a non-2xx response, a thrown fetch, and a followed redirect (an expired session landing on
 * /signin) all come back as a reported error instead of looking like success.
 */
export async function requestSuppress(
  finding: { fingerprint: string; resourceId?: string },
  reason: string,
  expiresAt: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<SuppressOutcome> {
  try {
    const res = await fetchImpl('/api/suppressions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fingerprint: finding.fingerprint, resourceId: finding.resourceId, reason, expiresAt }),
    });
    if (!res.ok || res.redirected) return { ok: false, error: await readError(res, SUPPRESS_FALLBACK) };
    return { ok: true, suppression: await res.json() as Suppression };
  } catch {
    return { ok: false, error: SUPPRESS_FALLBACK };
  }
}

/** Same contract for removing a suppression. A refused DELETE (403, 404, thrown fetch) is
 *  reported back rather than removed from the screen on the strength of the request alone. */
export async function requestUnsuppress(id: string, fetchImpl: typeof fetch = fetch): Promise<UnsuppressOutcome> {
  try {
    const res = await fetchImpl(`/api/suppressions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok || res.redirected) return { ok: false, error: await readError(res, UNSUPPRESS_FALLBACK) };
    return { ok: true, id };
  } catch {
    return { ok: false, error: UNSUPPRESS_FALLBACK };
  }
}

/** Applied to the current list rather than the one the request started from, so two suppression
 *  actions in flight at once cannot overwrite each other. A failed request returns the list
 *  untouched (same identity, so a caller can check whether anything actually changed). */
export function applySuppress(suppressions: Suppression[], outcome: SuppressOutcome): Suppression[] {
  if (!outcome.ok) return suppressions;
  return [...suppressions, outcome.suppression];
}

export function applyUnsuppress(suppressions: Suppression[], outcome: UnsuppressOutcome): Suppression[] {
  if (!outcome.ok) return suppressions;
  return suppressions.filter(s => s.id !== outcome.id);
}

export interface SuppressionsLoadState {
  suppressions: Suppression[];
  /** True only when the GET itself failed (non-2xx, bad body, thrown fetch) — never set for a
   *  genuinely empty 2xx response. Keeping these apart is the whole point: collapsing both into
   *  `[]` is what made a failed load look like "no suppressions" in widget mode. */
  failed: boolean;
}

/** Turns fetchJson's FetchResult into the two pieces of state the self-fetching (widget-mode)
 *  explorer needs, so `fetchJson(...).then(setSuppressions)`-style code can't collapse "couldn't
 *  load" and "loaded, empty" into the same `[]`. */
export function applySuppressionsLoad(result: FetchResult<Suppression[]>): SuppressionsLoadState {
  if (!result.ok) return { suppressions: [], failed: true };
  return { suppressions: result.data, failed: false };
}

/** GETs the suppression list for self-fetching callers (the widget-mode explorer, which gets no
 *  `suppressions` prop from a server-rendered page). Named distinctly from lib/suppressions.ts's
 *  server-side `loadSuppressions()` (a direct DB read) — this one is the client's `/api/suppressions`
 *  GET, going through fetchJson so a failed request is never confused with a genuinely empty list. */
export function fetchSuppressionList(): Promise<FetchResult<Suppression[]>> {
  return fetchJson<Suppression[]>('/api/suppressions');
}
