/**
 * What the snapshot screen holds in place of a run's findings: one answer from the snapshot route
 * (`/api/scans/[id]/snapshot`) for the page on screen. Written without React or the DOM so the whole read
 * path can be tested against a stubbed `fetch`; the screen subscribes to this store and draws what it
 * holds, the same shape as the explorer's `ViewFeed`.
 *
 * Three rules hold throughout. A response that arrives after a newer request was made is dropped,
 * whatever order the network delivers them in. A failed read is a state of its own that says it could
 * not load and why, never an empty list. And the request is the address's query (`snapshotUrl`), so a
 * link and a request cannot disagree.
 */
import { SEARCH_DEBOUNCE_MS, readJson, Store, type FetchFn } from './explorer-session';
import { SNAPSHOT_ERRORS, type SnapshotErrorCode, type SnapshotResponse } from './snapshot-response';
import type { SnapshotQuery } from './snapshot-query';
import { snapshotUrl } from './snapshot-screen';

/** `query` is the request the state is about, null before the first one. */
export type SnapshotState =
  | { status: 'loading'; stale?: SnapshotResponse; query: string | null }
  | { status: 'ready'; data: SnapshotResponse; query: string | null }
  /** The run is gone, or its records were never stored: neither is a failure, and each says why. */
  | { status: SnapshotErrorCode; message: string; query: string | null }
  /** A failed read keeps the last answer, so the filters stay on screen to change the request. */
  | { status: 'failed'; message: string; stale?: SnapshotResponse; query: string | null };

const isErrorCode = (code: unknown): code is SnapshotErrorCode => typeof code === 'string' && Object.hasOwn(SNAPSHOT_ERRORS, code);

/** A fetch that remembers the snapshot's own refusal (its `code` and sentence) when the server sends
 *  one, so the screen can tell a run that is gone from a read that failed. */
function noticing(fetchFn: FetchFn, seen: { code: SnapshotErrorCode; message: string }[]): FetchFn {
  return async (url, init) => {
    const res = await fetchFn(url, init);
    if (res.status === SNAPSHOT_ERRORS['not-found'].status || res.status === SNAPSHOT_ERRORS['no-records'].status) {
      const body = await res.clone().json().catch(() => null) as { code?: unknown; error?: unknown } | null;
      if (body && isErrorCode(body.code) && res.status === SNAPSHOT_ERRORS[body.code].status && typeof body.error === 'string') {
        seen.push({ code: body.code, message: body.error });
      }
    }
    return res;
  };
}

/** One run's page, read again on every change. */
export class SnapshotFeed extends Store<SnapshotState> {
  private latest = 0;
  private requested: string | null = null;
  private current: { scanId: string; query: SnapshotQuery } | null = null;
  private pending: { scanId: string; query: SnapshotQuery; timer: ReturnType<typeof setTimeout> } | null = null;
  private inFlight: AbortController | null = null;

  constructor(private readonly fetchFn: FetchFn, private readonly debounceMs = SEARCH_DEBOUNCE_MS) {
    super({ status: 'loading', query: null });
  }

  /** Reads the page unless it is the one already read or being read. A change to the search text alone
   *  waits `debounceMs` for more typing, and any later request replaces a waiting one. */
  request(scanId: string, query: SnapshotQuery): void {
    const url = snapshotUrl(scanId, query);
    if (url === this.requested) {
      this.cancelPending();
      return;
    }
    const current = this.current;
    if (current && this.debounceMs > 0 && scanId === current.scanId && query.search !== current.query.search
      && snapshotUrl(scanId, { ...query, search: '', page: 1 }) === snapshotUrl(scanId, { ...current.query, search: '', page: 1 })) {
      this.cancelPending();
      this.pending = { scanId, query, timer: setTimeout(() => { this.pending = null; this.start(scanId, query); }, this.debounceMs) };
      return;
    }
    this.cancelPending();
    this.start(scanId, query);
  }

  /** Reads the request on screen again, for a read that failed. A search still waiting for a pause is read now. */
  refresh(): void {
    const request = this.pending ?? this.current;
    if (!request) return;
    this.cancelPending();
    this.start(request.scanId, request.query);
  }

  /** Stops reading and drops what is on its way. Asking for the same page afterwards reads it again,
   *  since the answer that was coming was dropped. */
  dispose(): void {
    this.cancelPending();
    this.latest++;
    this.requested = null;
    this.inFlight?.abort();
  }

  private cancelPending() {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }

  private start(scanId: string, query: SnapshotQuery): void {
    const url = snapshotUrl(scanId, query);
    const id = ++this.latest;
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;
    this.current = { scanId, query };
    this.requested = url;
    const before = this.getSnapshot();
    const stale = before.status === 'ready' ? before.data : before.status === 'loading' || before.status === 'failed' ? before.stale : undefined;
    this.publish({ status: 'loading', stale, query: url });
    const seen: { code: SnapshotErrorCode; message: string }[] = [];
    void readJson<SnapshotResponse>(noticing(this.fetchFn, seen), url, 'the findings of this run', controller.signal).then(result => {
      if (id !== this.latest) return;
      const refusal = seen[0];
      if (result.ok) this.publish({ status: 'ready', data: result.data, query: url });
      else if (refusal) this.publish({ status: refusal.code, message: refusal.message, query: url });
      else this.publish({ status: 'failed', message: result.message, stale, query: url });
    });
  }
}
