/**
 * What a compare of two past scans is asked (ADR 0008): which two, which side and which page, in one place
 * for everyone who reads or writes it. The compare routes read it from their query string, the `/scans`
 * server page reads it from the address, and the screen writes it back to the address and to the routes'
 * requests, all through `compareQueryFromParams()` and `compareQueryToParams()`, so the address and the
 * request can never say different things.
 *
 * `compare=<idA>..<idB>` keeps the meaning it always had, and a link made before the compare moved to the
 * server opens the same one: Added, first page. The side and the page are `compareSide` and `comparePage`,
 * which the findings explorer and the snapshot (`snap*`) never read. No imports from the server, so a
 * client component can use it.
 */
import { COMPARE_SIDES, type CompareSide } from './compare-response';
import { MAX_SNAPSHOT_PAGE, SNAPSHOT_PAGE_SIZE } from './snapshot-query';

/** Findings a page of one side lists. */
export const COMPARE_PAGE_SIZE = SNAPSHOT_PAGE_SIZE;

export const COMPARE_PARAMS = {
  ids: 'compare',
  side: 'compareSide',
  page: 'comparePage',
} as const;

export interface CompareQuery {
  side: CompareSide;
  /** 1-based. */
  page: number;
}

export const DEFAULT_COMPARE_SIDE: CompareSide = 'added';
export const emptyCompareQuery = (): CompareQuery => ({ side: DEFAULT_COMPARE_SIDE, page: 1 });

type ParamSource = URLSearchParams | Record<string, string | string[] | undefined>;

function readFirst(source: ParamSource, name: string): string | undefined {
  if (source instanceof URLSearchParams) return source.get(name) ?? undefined;
  const value = source[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The two scan ids a `compare=` value names, or null when it does not name two. The ids may be in
 *  either order: the server says which is older. */
export function parseCompareIds(value: string | undefined | null): [string, string] | null {
  if (!value) return null;
  const [a, b, ...rest] = value.split('..');
  return a && b && rest.length === 0 ? [a, b] : null;
}

/** The query an address or a request holds. Anything unknown or malformed is ignored rather than
 *  rejected, so an old or hand-edited link still opens. */
export function compareQueryFromParams(source: ParamSource): CompareQuery {
  const side = COMPARE_SIDES.find(s => s === readFirst(source, COMPARE_PARAMS.side)) ?? DEFAULT_COMPARE_SIDE;
  const page = Number(readFirst(source, COMPARE_PARAMS.page));
  return { side, page: Number.isInteger(page) && page > 1 && page <= MAX_SNAPSHOT_PAGE ? page : 1 };
}

/** The query as params, with `base` (params the page itself owns, such as `tab` and `compare`) kept first
 *  and untouched. Defaults are left out, so the Added side's first page adds nothing. */
export function compareQueryToParams(query: CompareQuery, base?: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams(base);
  params.delete(COMPARE_PARAMS.side);
  params.delete(COMPARE_PARAMS.page);
  if (query.side !== DEFAULT_COMPARE_SIDE) params.set(COMPARE_PARAMS.side, query.side);
  if (query.page > 1) params.set(COMPARE_PARAMS.page, String(query.page));
  return params;
}
