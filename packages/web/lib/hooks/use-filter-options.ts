import { useCallback, useEffect, useState } from 'react';
import { fetchJson } from '../fetch-json';
import type { FilterOptions } from '../filter-options';

export type FilterOptionsRead =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; options: FilterOptions };

/** The one options read behind the shared filter component (`GET /api/filters/options`), read when the surface
 *  opens. A failed read is a state of its own, so a control built on it says it could not load rather than
 *  showing a list that is only empty because the read failed. */
export function useFilterOptions(): { read: FilterOptionsRead; retry: () => void } {
  const [read, setRead] = useState<FilterOptionsRead>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    void fetchJson<FilterOptions>('/api/filters/options').then(result => {
      if (live) setRead(result.ok ? { status: 'ready', options: result.data } : { status: 'failed' });
    });
    return () => { live = false; };
  }, [attempt]);

  const retry = useCallback(() => {
    setRead({ status: 'loading' });
    setAttempt(n => n + 1);
  }, []);
  return { read, retry };
}
