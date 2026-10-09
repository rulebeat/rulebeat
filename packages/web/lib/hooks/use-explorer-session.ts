'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { ExplorerSession, type FetchFn, type LazyReads, type Loaded } from '@/lib/explorer-session';

/** One explorer's session, made once. It reads through the browser's `fetch`, and stops reading when
 *  the explorer unmounts. */
export function useExplorerSession(): ExplorerSession {
  const [session] = useState(() => new ExplorerSession(((url, init) => fetch(url, init)) as FetchFn));
  useEffect(() => () => session.dispose(), [session]);
  return session;
}

/** What a session store holds now, re-rendering when it changes. */
export function useStore<S>(store: { subscribe: (listener: () => void) => () => void; getSnapshot: () => S }): S {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** The state of one lazy read, read when `url` is set (and again for a new one), with a way to read it
 *  again after it failed. Null while there is nothing to read. */
export function useLazyRead<T>(reads: LazyReads<T>, url: string | null): { state: Loaded<T> | undefined; retry: () => void } {
  const snapshot = useStore(reads);
  useEffect(() => { if (url) reads.load(url); }, [reads, url, snapshot.epoch]);
  const retry = useCallback(() => { if (url) reads.load(url, { retry: true }); }, [reads, url]);
  return { state: url ? snapshot.entries.get(url) : undefined, retry };
}
