/**
 * What the compare screen holds in place of two scans' findings: one answer from the compare route
 * (`/api/scans/compare`) for the side and page on screen. Written without React or the DOM so the whole
 * read path can be tested against a stubbed `fetch`; the screen subscribes to this store and draws what it
 * holds, the same shape as the snapshot's `SnapshotFeed`.
 *
 * Three rules hold throughout. A response that arrives after a newer request was made is dropped,
 * whatever order the network delivers them in. A failed read is a state of its own that says it could
 * not load and why, never an empty side. And the request is the address's query (`compareUrl`), so a
 * link and a request cannot disagree.
 */
import { readJson, Store, type FetchFn } from './explorer-session';
import { COMPARE_ERRORS, type CompareErrorCode, type CompareResponse } from './compare-response';
import type { CompareQuery } from './compare-query';
import { compareUrl, type CompareIds } from './compare-screen';

/** `query` is the request the state is about, null before the first one. */
export type CompareState =
  | { status: 'loading'; stale?: CompareResponse; query: string | null }
  | { status: 'ready'; data: CompareResponse; query: string | null }
  /** A run is gone, has no stored findings, or is of another category: none is a failure, and each says why. */
  | { status: CompareErrorCode; message: string; query: string | null }
  /** A failed read keeps the last answer, so the tiles stay on screen to change the request. */
  | { status: 'failed'; message: string; stale?: CompareResponse; query: string | null };

const isErrorCode = (code: unknown): code is CompareErrorCode => typeof code === 'string' && Object.hasOwn(COMPARE_ERRORS, code);
const REFUSALS: ReadonlySet<number> = new Set(Object.values(COMPARE_ERRORS).map(e => e.status));

/** A fetch that remembers the compare's own refusal (its `code` and sentence) when the server sends one,
 *  so the screen can tell a run that is gone from a read that failed. */
function noticing(fetchFn: FetchFn, seen: { code: CompareErrorCode; message: string }[]): FetchFn {
  return async (url, init) => {
    const res = await fetchFn(url, init);
    if (REFUSALS.has(res.status)) {
      const body = await res.clone().json().catch(() => null) as { code?: unknown; error?: unknown } | null;
      if (body && isErrorCode(body.code) && res.status === COMPARE_ERRORS[body.code].status && typeof body.error === 'string') {
        seen.push({ code: body.code, message: body.error });
      }
    }
    return res;
  };
}

/** Two runs' compare, one side's page, read again on every change. */
export class CompareFeed extends Store<CompareState> {
  private latest = 0;
  private requested: string | null = null;
  private current: { ids: CompareIds; query: CompareQuery } | null = null;
  private inFlight: AbortController | null = null;

  constructor(private readonly fetchFn: FetchFn) {
    super({ status: 'loading', query: null });
  }

  /** Reads the page unless it is the one already read or being read. */
  request(ids: CompareIds, query: CompareQuery): void {
    if (compareUrl(ids, query) === this.requested) return;
    this.start(ids, query);
  }

  /** Reads the request on screen again, for a read that failed. */
  refresh(): void {
    if (this.current) this.start(this.current.ids, this.current.query);
  }

  /** Stops reading and drops what is on its way. Asking for the same page afterwards reads it again,
   *  since the answer that was coming was dropped. */
  dispose(): void {
    this.latest++;
    this.requested = null;
    this.inFlight?.abort();
  }

  private start(ids: CompareIds, query: CompareQuery): void {
    const url = compareUrl(ids, query);
    const id = ++this.latest;
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;
    this.current = { ids, query };
    this.requested = url;
    const before = this.getSnapshot();
    const stale = before.status === 'ready' ? before.data : before.status === 'loading' || before.status === 'failed' ? before.stale : undefined;
    this.publish({ status: 'loading', stale, query: url });
    const seen: { code: CompareErrorCode; message: string }[] = [];
    void readJson<CompareResponse>(noticing(this.fetchFn, seen), url, 'the findings of this compare', controller.signal).then(result => {
      if (id !== this.latest) return;
      const refusal = seen[0];
      if (result.ok) this.publish({ status: 'ready', data: result.data, query: url });
      else if (refusal) this.publish({ status: refusal.code, message: refusal.message, query: url });
      else this.publish({ status: 'failed', message: result.message, stale, query: url });
    });
  }
}
