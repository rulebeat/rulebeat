/**
 * What the compare screen decides to draw and where it points (ADR 0008), as functions of what the
 * session holds, so each decision can be tested without rendering anything. A failed read comes before an
 * empty side, so a failure is never drawn as a compare in which nothing changed. Client-safe: no Node, no
 * database.
 */
import type { ExportFormat } from './findings-export';
import type { CompareState } from './compare-session';
import { COMPARE_PARAMS, compareQueryToParams, type CompareQuery } from './compare-query';
import { COMPARE_SIDES, type CompareResponse, type CompareSide, type CompareTotals } from './compare-response';

/** The two scan ids a compare is about, as the address wrote them. */
export type CompareIds = readonly [string, string];

const idsValue = (ids: CompareIds) => `${ids[0]}..${ids[1]}`;

/** The read of one page of one side. The query string is the address's own `compareQueryToParams`, with
 *  the ids first, so a link and a request cannot disagree. */
export function compareUrl(ids: CompareIds, query: CompareQuery): string {
  return `/api/scans/compare?${compareQueryToParams(query, new URLSearchParams({ [COMPARE_PARAMS.ids]: idsValue(ids) }))}`;
}

/** The file of every finding on the side. A file has no page. */
export function compareExportUrl(ids: CompareIds, query: CompareQuery, format: ExportFormat): string {
  const params = compareQueryToParams({ ...query, page: 1 }, new URLSearchParams({ [COMPARE_PARAMS.ids]: idsValue(ids) }));
  params.set('format', format);
  return `/api/scans/compare/export?${params}`;
}

/** The compare's own addition to the page's address: the ids, the side and the page, kept after whatever
 *  else the address holds. The Added side's first page adds only the ids. */
export function compareAddress(ids: CompareIds, query: CompareQuery, base: URLSearchParams): string {
  const params = new URLSearchParams(base);
  params.set(COMPARE_PARAMS.ids, idsValue(ids));
  return compareQueryToParams(query, params).toString();
}

// ---- The query ----

/** A side chosen: back on its first page, since the page of another side means nothing here. */
export const switchedCompareQuery = (query: CompareQuery, side: CompareSide): CompareQuery =>
  side === query.side ? query : { side, page: 1 };

export const pagedCompareQuery = (query: CompareQuery, page: number): CompareQuery => ({ ...query, page });

// ---- The tiles ----

export interface CompareTile { side: CompareSide; value: string; label: string; numeral: string; pressed: boolean }

const TILES: Record<CompareSide, { label: string; sign: string; numeral: string }> = {
  added: { label: 'Added', sign: '+', numeral: 'text-sev-critical' },
  fixed: { label: 'Fixed', sign: '-', numeral: 'text-status-ok' },
  persisted: { label: 'Persisted', sign: '', numeral: 'text-ink' },
};

/** The three tiles, which are also the side control. The counts are all three totals of the answer on
 *  screen, so they do not change when a side is chosen. */
export function compareTiles(totals: CompareTotals | undefined, side: CompareSide): CompareTile[] {
  return COMPARE_SIDES.map(key => ({
    side: key,
    value: totals ? `${TILES[key].sign}${totals[key]}` : '…',
    label: TILES[key].label,
    numeral: TILES[key].numeral,
    pressed: key === side,
  }));
}

export const compareSideLabel = (side: CompareSide) => TILES[side].label.toLowerCase();

// ---- The screen ----

export type CompareScreen =
  | 'loading' | 'unavailable' | 'not-found' | 'no-records' | 'different-categories' | 'bad-request' | 'empty-side' | 'rows';

/** The answer on screen: the last one while the next is on its way, and after a failed read, so the tiles
 *  stay on screen to change the request. */
export function compareDataOf(state: CompareState): CompareResponse | undefined {
  return state.status === 'ready' ? state.data : state.status === 'loading' || state.status === 'failed' ? state.stale : undefined;
}

/** The card's title. It describes what the card lists, so it names the side of the answer on screen and
 *  that side's total, not the side just chosen: the tile follows the choice at once, the card follows
 *  the answer, and the two agree again when the next answer arrives. */
export const compareCardTitle = (data: CompareResponse): string =>
  `${TILES[data.side].label} findings (${data.totals[data.side]})`;

/** The query the card acts on. Everything inside the card belongs to the answer on screen, so its export and
 *  its pager ask about that answer's side and page, whatever side has been chosen since. If the choice had
 *  moved on, a click inside the card moves it back, which is what was clicked. When the answer and the
 *  choice agree, this is the query already held. */
export const compareCardQuery = (data: CompareResponse): CompareQuery => ({ side: data.side, page: data.page });

/** The file the card's export is saved as: the side the card lists. */
export const compareExportFileName = (data: CompareResponse): string => `compare-${data.side}`;

/** Which of the eight screens the compare shows. */
export function compareScreenOf(state: CompareState): CompareScreen {
  if (state.status === 'failed') return 'unavailable';
  if (state.status === 'not-found' || state.status === 'no-records' || state.status === 'different-categories' || state.status === 'bad-request') {
    return state.status;
  }
  const data = compareDataOf(state);
  if (!data) return 'loading';
  return data.totals[data.side] === 0 ? 'empty-side' : 'rows';
}

/** What an empty side says, by side. */
export const emptySideMessage = (side: CompareSide) => `No ${compareSideLabel(side)} findings between these two scans.`;
