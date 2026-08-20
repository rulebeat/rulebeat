'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson } from '@/lib/fetch-json';

// Mirrors AZURE_CALL_TIMEOUT_MS (packages/core/src/net/fetch-retry.ts) — reimplemented locally
// since that module carries Node-only deps not meant for a client bundle.
const WIDGET_FETCH_TIMEOUT_MS = 30_000;

interface UseWidgetFetchResult<T> {
  data: T | null;
  loading: boolean;
  failed: boolean;
  retry: () => void;
}

/**
 * Shared fetch/loading/failed/retry state for dashboard widgets, built on fetchJson's
 * FetchResult contract. Guards two things a plain useEffect + fetchJson doesn't: a slower,
 * superseded response overwriting a newer one (a monotonic request id discards it on arrival),
 * and a request that never settles (bounded by a 30s timeout so it resolves to `failed` instead
 * of leaving the widget spinning forever).
 *
 * `deps` are extra invalidation triggers not already encoded in `url` (a dashboard-wide
 * `refreshKey`, most commonly) — `url` itself is always a dependency.
 */
export function useWidgetFetch<T>(url: string, deps: unknown[] = []): UseWidgetFetchResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const requestId = useRef(0);

  useEffect(() => {
    const id = ++requestId.current;
    // Fetch-on-mount/dep-change: an external-system read, not derivable render state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setFailed(false);
    const signal = AbortSignal.timeout(WIDGET_FETCH_TIMEOUT_MS);
    fetchJson<T>(url, { signal }).then(result => {
      if (id !== requestId.current) return; // superseded by a newer request — ignore
      setLoading(false);
      if (result.ok) {
        setData(result.data);
      } else {
        setFailed(true);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, retryTick, ...deps]);

  const retry = useCallback(() => setRetryTick(t => t + 1), []);

  return { data, loading, failed, retry };
}
