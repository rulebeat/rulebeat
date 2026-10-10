/**
 * What a snapshot of one past scan is asked (ADR 0008): which of its findings to list, in one place for
 * everyone who reads or writes it. The snapshot routes read it from their query string, the `/scans`
 * server page reads it from the address, and the screen writes it back to the address and to the
 * routes' requests, all through `snapshotQueryFromParams()` and `snapshotQueryToParams()`, so the
 * address and the request can never say different things.
 *
 * The parameters are named for the snapshot, never `severity`, `ruleId`, `q` or `page`: those belong to
 * the findings explorer on the same page, and a link must never mean one thing to the explorer and
 * another to the snapshot. No imports from the server, so a client component can use it.
 */
import { EXPLORER_SEVERITIES } from './explorer-filters';

/** Findings a page of the snapshot lists. */
export const SNAPSHOT_PAGE_SIZE = 50;
/** The furthest page an address may name, so a hand-written link cannot ask for an absurd offset. */
export const MAX_SNAPSHOT_PAGE = 100_000;

export const SNAPSHOT_PARAMS = {
  severity: 'snapSeverity',
  rule: 'snapRule',
  search: 'snapQ',
  page: 'snapPage',
} as const;

export interface SnapshotQuery {
  /** Severities listed; none means every one. */
  severity: string[];
  /** Rule ids listed; none means every rule. */
  rule: string[];
  /** Text a finding's resource name, rule name, type or resource id contains, ignoring case. */
  search: string;
  /** 1-based. */
  page: number;
}

export const emptySnapshotQuery = (): SnapshotQuery => ({ severity: [], rule: [], search: '', page: 1 });

type ParamSource = URLSearchParams | Record<string, string | string[] | undefined>;

function readAll(source: ParamSource, name: string): string[] {
  if (source instanceof URLSearchParams) return source.getAll(name);
  const value = source[name];
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/** The query an address or a request holds. Anything unknown or malformed is ignored rather than
 *  rejected, so an old or hand-edited link still opens. */
export function snapshotQueryFromParams(source: ParamSource): SnapshotQuery {
  const severities = new Set(readAll(source, SNAPSHOT_PARAMS.severity).filter(s => (EXPLORER_SEVERITIES as string[]).includes(s)));
  const rules = new Set(readAll(source, SNAPSHOT_PARAMS.rule).filter(r => r !== ''));
  const page = Number(readAll(source, SNAPSHOT_PARAMS.page)[0]);
  return {
    // In severity order, so two orders of one choice are one address.
    severity: EXPLORER_SEVERITIES.filter(s => severities.has(s)),
    rule: [...rules],
    search: (readAll(source, SNAPSHOT_PARAMS.search)[0] ?? '').trim(),
    page: Number.isInteger(page) && page > 1 && page <= MAX_SNAPSHOT_PAGE ? page : 1,
  };
}

/** The query as params, with `base` (params the page itself owns, such as `tab`, `run` and `scan`) kept
 *  first and untouched. Defaults are left out, so the unfiltered first page adds nothing. */
export function snapshotQueryToParams(query: SnapshotQuery, base?: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams(base);
  for (const name of Object.values(SNAPSHOT_PARAMS)) params.delete(name);
  for (const severity of query.severity) params.append(SNAPSHOT_PARAMS.severity, severity);
  for (const rule of query.rule) params.append(SNAPSHOT_PARAMS.rule, rule);
  if (query.search.trim() !== '') params.set(SNAPSHOT_PARAMS.search, query.search.trim());
  if (query.page > 1) params.set(SNAPSHOT_PARAMS.page, String(query.page));
  return params;
}
