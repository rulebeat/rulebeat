export type FetchResult<T> = { ok: true; data: T } | { ok: false };

/**
 * GETs JSON and returns a discriminated result instead of collapsing every failure into `null`.
 * `{ ok: false }` covers a non-2xx response, a body that fails to parse as JSON, a thrown/network
 * exception, and an aborted or timed-out signal — callers that need to tell those apart from a
 * genuinely empty 2xx response can do so, instead of every case looking like "no data".
 */
export async function fetchJson<T>(url: string, opts?: { signal?: AbortSignal }): Promise<FetchResult<T>> {
  try {
    const res = await fetch(url, { signal: opts?.signal });
    if (!res.ok) return { ok: false };
    const data = await res.json() as T;
    return { ok: true, data };
  } catch {
    return { ok: false };
  }
}
