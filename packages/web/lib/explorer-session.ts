/**
 * What the explorer holds in place of every finding: one answer from the server view routes
 * (`/api/findings/{view,rows,group,column-values}`; the export's file is `/api/findings/export`) for the view on screen, plus the lazy reads a
 * viewer opens (a column's values, a group's contents, a finding's further rows). Written without
 * React or the DOM so the whole read path can be tested against a stubbed `fetch`; the explorer
 * subscribes to these stores and draws what they hold.
 *
 * Three rules hold throughout. A response that arrives after a newer request was made is dropped,
 * whatever order the network delivers them in. A failed read is a state of its own that says it could
 * not load and why, never an empty list. And the query string of a read is the explorer's address
 * (`viewToSearchParams`) plus the tab and the suppressed flag, so a link and a request cannot disagree.
 */
import { isRowField, rowField, viewToSearchParams, type RowField, type View, type ViewField, type ViewFilter } from './finding-view';
import type { ExportFormat } from './findings-export';
import {
  type ColumnValuesResponse, type FindingRowsResponse, type GroupResponse, type ViewResponse, type ViewTab,
} from './view-response';
import { OPEN_VIEW_PARAM } from './saved-view-query';

/** How long typing in the search box waits before the view is read again. Every other change reads at once. */
export const SEARCH_DEBOUNCE_MS = 250;
/** How long a read may take before it is called failed, as long as the dashboard widgets allow. */
export const READ_TIMEOUT_MS = 30_000;

export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/** The view on screen with the two things a View does not hold: which tab, and whether suppressed
 *  findings are listed. */
export interface ViewRequest { view: View; tab: ViewTab; showSuppressed: boolean }

// ---- The requests ----

const ROUTE = '/api/findings';

/** The query of a view read: the tab and the suppressed flag, then exactly what the address carries. */
export function viewQuery(request: ViewRequest): string {
  const base: Record<string, string> = { tab: request.tab };
  if (request.showSuppressed) base.suppressed = '1';
  return viewToSearchParams(request.view, base).toString();
}

export const viewUrl = (request: ViewRequest) => `${ROUTE}/view?${viewQuery(request)}`;

/** The filters a locked category does not own: its category is the page's, so it stays out of the
 *  URL and out of a saved view. Without a locked category, all of them. */
export function filtersWithoutLockedCategory(filters: ViewFilter[], lockedCategory?: string): ViewFilter[] {
  return lockedCategory ? filters.filter(f => f.field !== 'category') : filters;
}

/** The query the explorer writes to the address for a view. `viewToSearchParams` is the one writer of
 *  every param `viewFromSearchParams` reads, so a deep link survives the first render, and a read of
 *  the view carries the same params. `viewId` is the saved view the address says is open. */
export function explorerAddress(
  view: View,
  opts: { extraParams?: Record<string, string>; viewId?: string | null; lockedCategory?: string } = {},
): string {
  const base = opts.viewId ? { ...opts.extraParams, [OPEN_VIEW_PARAM]: opts.viewId } : opts.extraParams;
  return viewToSearchParams({ ...view, filters: filtersWithoutLockedCategory(view.filters, opts.lockedCategory) }, base).toString();
}

/** The params the three lazy reads share. The page is the view's own position, which none of them
 *  depends on, so paging the list does not make a group or a dropdown read again. */
function lazyParams(request: ViewRequest): URLSearchParams {
  return new URLSearchParams(viewQuery({ ...request, view: { ...request.view, page: 1 } }));
}

/** A row condition a group puts on its findings' rows: `value` null is the empty-value group. */
export interface RowCondition { path: string; value: string | null }

/** The view with a condition added as a filter on that returned column, so a read of rows sees only
 *  the rows its group holds. A condition on a column the view already filters narrows that filter to
 *  the one value, which is the same rows since the group's value is one of the filter's. */
function withConditions(view: View, conditions: readonly RowCondition[]): View {
  let filters: ViewFilter[] = view.filters;
  for (const c of conditions) {
    const field = rowField(c.path);
    filters = [...filters.filter(f => f.field !== field), { field, values: [c.value ?? ''] }];
  }
  return { ...view, filters };
}

export function rowsUrl(request: ViewRequest, fingerprint: string, rowsPage: number, conditions: readonly RowCondition[] = []): string {
  const params = lazyParams({ ...request, view: withConditions(request.view, conditions) });
  params.set('fingerprint', fingerprint);
  if (rowsPage > 1) params.set('rowsPage', String(rowsPage));
  return `${ROUTE}/rows?${params}`;
}

export function groupUrl(request: ViewRequest, groupPath: readonly (string | null)[], groupPage: number): string {
  const params = lazyParams(request);
  params.set('groupPath', JSON.stringify(groupPath));
  if (groupPage > 1) params.set('groupPage', String(groupPage));
  return `${ROUTE}/group?${params}`;
}

/** One rule's findings for the By rule list: the view narrowed to that rule alone, ungrouped, at
 *  `page`. It is a view read like any other, so the rows and counts it holds agree with the list. */
export function ruleFindingsUrl(request: ViewRequest, ruleId: string, page: number): string {
  const filters = [...request.view.filters.filter(f => f.field !== 'rule'), { field: 'rule' as const, values: [ruleId] }];
  return viewUrl({ ...request, view: { ...request.view, filters, groupBy: [], page } });
}

export function columnValuesUrl(request: ViewRequest, column: RowField, valueQuery: string): string {
  const params = lazyParams(request);
  params.set('column', column);
  if (valueQuery !== '') params.set('valueQuery', valueQuery);
  return `${ROUTE}/column-values?${params}`;
}

/** Where the file of the view's findings comes from. It is the view's own query, so the file holds
 *  what the list holds, every page of it; the page is dropped because the export has none. */
export function exportUrl(request: ViewRequest, format: ExportFormat): string {
  const params = lazyParams(request);
  params.set('format', format);
  return `${ROUTE}/export?${params}`;
}

// ---- Reading one answer ----

export type Fetched<T> = { ok: true; data: T } | { ok: false; message: string };

const asSentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** What a failed read says. The server's own message is kept when it already says it could not load
 *  (a 500 never carries more than a stable sentence), and otherwise follows "Could not load". */
async function describeFailure(res: Response, what: string): Promise<string> {
  let reason = `The server answered ${res.status}.`;
  try {
    const body = await res.json() as { error?: unknown };
    if (typeof body.error === 'string' && body.error !== '') {
      if (/^could not/i.test(body.error)) return asSentence(body.error);
      reason = asSentence(body.error);
    }
  } catch {
    // A body that is not JSON leaves the status as the reason.
  }
  return `Could not load ${what}. ${reason}`;
}

/** GETs one JSON answer. `what` completes "Could not load ...". An aborted read (superseded by a
 *  newer one) comes back failed too, and the caller drops it by its sequence number. */
export async function readJson<T>(fetchFn: FetchFn, url: string, what: string, signal?: AbortSignal): Promise<Fetched<T>> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, READ_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetchFn(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, message: await describeFailure(res, what) };
    try {
      return { ok: true, data: await res.json() as T };
    } catch {
      return { ok: false, message: `Could not load ${what}. The answer could not be read.` };
    }
  } catch {
    return {
      ok: false,
      message: `Could not load ${what}. ${timedOut ? 'The server took too long to answer.' : 'The request did not reach the server.'}`,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// ---- Stores ----

/** `stale` is what the last settled read held, kept on screen while the next one is on its way. */
export type Loaded<T> =
  | { status: 'loading'; stale?: T }
  | { status: 'ready'; data: T }
  | { status: 'failed'; message: string };

export class Store<S> {
  private snapshot: S;
  private readonly listeners = new Set<() => void>();
  constructor(initial: S) { this.snapshot = initial; }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = () => this.snapshot;
  protected publish(next: S) {
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}

/** `query` is the view query the state is about, so a caller can tell whether what it holds is the
 *  answer to the request on screen or to an earlier one. Null before the first request. */
export type ViewState =
  | { status: 'loading'; stale?: ViewResponse; query: string | null }
  | { status: 'ready'; data: ViewResponse; query: string | null }
  /** A failed read keeps the last answer, so the controls stay on screen to change the view. */
  | { status: 'failed'; message: string; stale?: ViewResponse; query: string | null };

/** Only the search text and the page: what changes while someone types. */
function withoutSearch(request: ViewRequest): string {
  return viewQuery({ ...request, view: { ...request.view, search: '', page: 1 } });
}

/** The view's answer, read again on every change. */
export class ViewFeed extends Store<ViewState> {
  private latest = 0;
  private requested: string | null = null;
  private current: ViewRequest | null = null;
  private pending: { request: ViewRequest; timer: ReturnType<typeof setTimeout> } | null = null;
  private inFlight: AbortController | null = null;

  constructor(private readonly fetchFn: FetchFn, private readonly debounceMs = SEARCH_DEBOUNCE_MS) {
    super({ status: 'loading', query: null });
  }

  /** Reads the view unless it is the one already read or being read. A change to the search text
   *  alone waits `debounceMs` for more typing, and any later request replaces a waiting one. */
  request(request: ViewRequest): void {
    const query = viewQuery(request);
    if (query === this.requested) {
      this.cancelPending();
      return;
    }
    if (this.current && this.debounceMs > 0
      && request.view.search !== this.current.view.search && withoutSearch(request) === withoutSearch(this.current)) {
      this.cancelPending();
      this.pending = { request, timer: setTimeout(() => { this.pending = null; this.start(request); }, this.debounceMs) };
      return;
    }
    this.cancelPending();
    this.start(request);
  }

  /** Reads the current view again, for when what is stored changed under it (a scan finished). */
  refresh(): void {
    const request = this.pending?.request ?? this.current;
    if (!request) return;
    this.cancelPending();
    this.start(request);
  }

  /** Stops reading and drops what is on its way. Asking for the same view afterwards reads it again,
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

  private start(request: ViewRequest): void {
    const query = viewQuery(request);
    const id = ++this.latest;
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;
    this.current = request;
    this.requested = query;
    const before = this.getSnapshot();
    const stale = before.status === 'ready' ? before.data : before.status === 'loading' ? before.stale : undefined;
    this.publish({ status: 'loading', stale, query });
    void readJson<ViewResponse>(this.fetchFn, viewUrl(request), 'the findings', controller.signal).then(result => {
      if (id !== this.latest) return;
      this.publish(result.ok ? { status: 'ready', data: result.data, query } : { status: 'failed', message: result.message, stale, query });
    });
  }
}

export interface LazySnapshot<T> {
  /** Counts resets, so a reader can read again what a reset cleared. */
  epoch: number;
  entries: ReadonlyMap<string, Loaded<T>>;
}

/** Reads keyed by their URL. A read is made once; asking again while it is loading or ready does
 *  nothing, and asking again after it failed is `retry`. Each URL carries the whole view, so a
 *  changed view is a new key, and an answer is never shown for a view it was not read for. */
export class LazyReads<T> extends Store<LazySnapshot<T>> {
  constructor(private readonly fetchFn: FetchFn, private readonly what: string) {
    super({ epoch: 0, entries: new Map() });
  }

  load(url: string, opts: { retry?: boolean } = {}): void {
    const { epoch, entries } = this.getSnapshot();
    const existing = entries.get(url);
    if (existing && !(opts.retry && existing.status === 'failed')) return;
    this.set(url, { status: 'loading' });
    void readJson<T>(this.fetchFn, url, this.what).then(result => {
      if (this.getSnapshot().epoch !== epoch) return;
      this.set(url, result.ok ? { status: 'ready', data: result.data } : { status: 'failed', message: result.message });
    });
  }

  /** Forgets every read, for when what is stored changed under them. */
  reset(): void {
    this.publish({ epoch: this.getSnapshot().epoch + 1, entries: new Map() });
  }

  private set(url: string, state: Loaded<T>) {
    const { epoch, entries } = this.getSnapshot();
    this.publish({ epoch, entries: new Map(entries).set(url, state) });
  }
}

/** Where a dropdown reads its values from instead of holding them: the server's top values of a
 *  returned column, searched on the server. The dropdown reads when it opens, since its panel exists
 *  only while it is open, and again for each search text once typing pauses. */
export interface RemoteValues {
  subscribe: (listener: () => void) => () => void;
  read: (valueQuery: string) => Loaded<ColumnValuesResponse> | undefined;
  load: (valueQuery: string, opts?: { retry?: boolean }) => void;
}

/** The values a dropdown of `field` reads, or nothing for a field the findings carry themselves, whose
 *  values the facets of the view already hold. Each text is a read of its own, keyed by the view it
 *  was made for. */
export function remoteValuesFor(session: ExplorerSession, request: ViewRequest, field: ViewField): RemoteValues | undefined {
  if (!isRowField(field)) return undefined;
  return {
    subscribe: session.values.subscribe,
    read: valueQuery => session.values.getSnapshot().entries.get(columnValuesUrl(request, field, valueQuery)),
    load: (valueQuery, opts) => session.values.load(columnValuesUrl(request, field, valueQuery), opts),
  };
}

/** Everything one explorer reads from the server. */
export class ExplorerSession {
  readonly view: ViewFeed;
  readonly rows: LazyReads<FindingRowsResponse>;
  readonly groups: LazyReads<GroupResponse>;
  readonly values: LazyReads<ColumnValuesResponse>;
  readonly ruleFindings: LazyReads<ViewResponse>;

  constructor(private readonly fetchFn: FetchFn, opts: { debounceMs?: number } = {}) {
    this.view = new ViewFeed(fetchFn, opts.debounceMs);
    this.rows = new LazyReads(fetchFn, 'these rows');
    this.groups = new LazyReads(fetchFn, 'this group');
    this.values = new LazyReads(fetchFn, 'the values');
    this.ruleFindings = new LazyReads(fetchFn, 'this rule\'s findings');
  }

  /** A scan finished: read the view again, and forget the lazy reads so each open one reads again. */
  refresh(): void {
    this.view.refresh();
    this.rows.reset();
    this.groups.reset();
    this.values.reset();
    this.ruleFindings.reset();
  }

  dispose(): void {
    this.view.dispose();
  }
}
