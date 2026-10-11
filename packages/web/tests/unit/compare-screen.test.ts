/**
 * ADR 0008: what the compare screen decides to draw, and where it points, as functions of what the
 * session holds. A failed read is never drawn as a side with nothing on it, and a refused compare says why.
 */
import { describe, expect, it } from 'vitest';
import type { CompareState } from '@/lib/compare-session';
import { COMPARE_ERRORS, type CompareResponse } from '@/lib/compare-response';
import { emptyCompareQuery, type CompareQuery } from '@/lib/compare-query';
import {
  compareAddress, compareCardQuery, compareCardTitle, compareDataOf, compareExportFileName, compareExportUrl, compareScreenOf, compareTiles, compareUrl, emptySideMessage,
  pagedCompareQuery, switchedCompareQuery,
} from '@/lib/compare-screen';

const IDS = ['run-1', 'run-2'] as const;
const query = (over: Partial<CompareQuery> = {}): CompareQuery => ({ ...emptyCompareQuery(), ...over });
const response = (over: Partial<CompareResponse> = {}): CompareResponse => ({
  older: { id: 'run-1', category: 'compute', startedAt: '2026-01-01T00:00:00.000Z' },
  newer: { id: 'run-2', category: 'compute', startedAt: '2026-01-02T00:00:00.000Z' },
  side: 'added', totals: { added: 2, fixed: 1, persisted: 3 }, page: 1, pageCount: 1, pageSize: 50, items: [], ...over,
});

describe('where the compare points', () => {
  it('reads a side\'s page at the route, with the ids first and the defaults left out', () => {
    expect(compareUrl(IDS, query())).toBe('/api/scans/compare?compare=run-1..run-2');
    expect(compareUrl(IDS, query({ side: 'fixed' }))).toBe('/api/scans/compare?compare=run-1..run-2&compareSide=fixed');
    expect(compareUrl(IDS, query({ side: 'persisted', page: 4 }))).toBe('/api/scans/compare?compare=run-1..run-2&compareSide=persisted&comparePage=4');
  });

  it('exports the side without a page, in the format asked for', () => {
    expect(compareExportUrl(IDS, query({ side: 'fixed', page: 3 }), 'csv')).toBe('/api/scans/compare/export?compare=run-1..run-2&compareSide=fixed&format=csv');
    expect(compareExportUrl(IDS, query(), 'json')).toBe('/api/scans/compare/export?compare=run-1..run-2&format=json');
  });

  it('writes the same query to the address that it reads from the route', () => {
    const q = query({ side: 'persisted', page: 2 });
    const address = new URLSearchParams(compareAddress(IDS, q, new URLSearchParams('tab=history')));
    const request = new URL(compareUrl(IDS, q), 'http://localhost').searchParams;
    expect(address.get('compare')).toBe(request.get('compare'));
    expect(address.get('compareSide')).toBe(request.get('compareSide'));
    expect(address.get('comparePage')).toBe(request.get('comparePage'));
  });

  it('puts the ids with the scan ids encoded when they hold characters an address reserves', () => {
    expect(compareUrl(['a&b', 'c d'], query())).toBe('/api/scans/compare?compare=a%26b..c+d');
  });
});

describe('choosing a side or a page', () => {
  it('goes back to the first page when another side is chosen', () => {
    expect(switchedCompareQuery(query({ side: 'added', page: 4 }), 'persisted')).toEqual({ side: 'persisted', page: 1 });
  });

  it('keeps the page when the side already chosen is chosen again, so it asks for nothing new', () => {
    const q = query({ side: 'fixed', page: 3 });
    expect(switchedCompareQuery(q, 'fixed')).toBe(q);
  });

  it('keeps the side when the page changes', () => {
    expect(pagedCompareQuery(query({ side: 'fixed' }), 5)).toEqual({ side: 'fixed', page: 5 });
  });
});

describe('the tiles', () => {
  it('show all three totals, signed, with the side on screen pressed', () => {
    expect(compareTiles({ added: 2, fixed: 1, persisted: 3 }, 'fixed')).toEqual([
      { side: 'added', value: '+2', label: 'Added', numeral: 'text-sev-critical', pressed: false },
      { side: 'fixed', value: '-1', label: 'Fixed', numeral: 'text-status-ok', pressed: true },
      { side: 'persisted', value: '3', label: 'Persisted', numeral: 'text-ink', pressed: false },
    ]);
  });

  it('show no number before the first answer, rather than a zero', () => {
    expect(compareTiles(undefined, 'added').map(t => t.value)).toEqual(['…', '…', '…']);
  });
});

describe('the card\'s title', () => {
  it('names the side and the total of the answer on screen', () => {
    expect(compareCardTitle(response({ side: 'fixed', totals: { added: 2, fixed: 7, persisted: 3 } }))).toBe('Fixed findings (7)');
    expect(compareCardTitle(response({ side: 'persisted', totals: { added: 2, fixed: 7, persisted: 3 } }))).toBe('Persisted findings (3)');
  });

  it('keeps naming the answer on screen while another side is on its way', () => {
    // The Added side's answer is on screen and the query has already moved to Fixed. The tile follows the
    // query (pressed), the card follows what it lists.
    const onScreen = response({ side: 'added', totals: { added: 2, fixed: 7, persisted: 3 } });
    const state: CompareState = { status: 'loading', stale: onScreen, query: null };
    const chosen = query({ side: 'fixed' });
    expect(compareTiles(compareDataOf(state)?.totals, chosen.side).find(t => t.pressed)?.side).toBe('fixed');
    expect(compareCardTitle(compareDataOf(state)!)).toBe('Added findings (2)');
  });
});

describe('the card\'s own controls', () => {
  // The Added answer (page 2 of 3) is on screen while the choice has already moved to Fixed.
  const onScreen = response({ side: 'added', totals: { added: 120, fixed: 7, persisted: 3 }, page: 2, pageCount: 3 });
  const chosen = query({ side: 'fixed' });

  it('acts on the side and page of the answer on screen, whatever has been chosen', () => {
    expect(compareCardQuery(onScreen)).toEqual(query({ side: 'added', page: 2 }));
  });

  it('exports the side the card lists, under that side\'s file name, not the side just chosen', () => {
    const url = new URL(compareExportUrl(IDS, compareCardQuery(onScreen), 'csv'), 'http://localhost');
    expect(url.pathname).toBe('/api/scans/compare/export');
    expect(url.searchParams.get('compareSide')).toBeNull();
    expect(url.searchParams.get('format')).toBe('csv');
    expect(compareExportFileName(onScreen)).toBe('compare-added');
    // What the card used to do, to show the two differ in this case.
    expect(compareExportUrl(IDS, chosen, 'csv')).toContain('compareSide=fixed');
  });

  it('exports a side other than the default by naming it', () => {
    const fixed = response({ side: 'fixed', totals: { added: 2, fixed: 7, persisted: 3 } });
    expect(new URL(compareExportUrl(IDS, compareCardQuery(fixed), 'json'), 'http://localhost').searchParams.get('compareSide')).toBe('fixed');
    expect(compareExportFileName(fixed)).toBe('compare-fixed');
  });

  it('pages the side the card lists, which moves the choice back to it', () => {
    const next = pagedCompareQuery(compareCardQuery(onScreen), 3);
    expect(next).toEqual(query({ side: 'added', page: 3 }));
    expect(next.side).not.toBe(chosen.side);
  });

  it('changes nothing when the answer on screen and the choice agree', () => {
    const agreed = response({ side: 'fixed', totals: { added: 2, fixed: 120, persisted: 3 }, page: 2, pageCount: 3 });
    const q = query({ side: 'fixed', page: 2 });
    expect(compareCardQuery(agreed)).toEqual(q);
    expect(pagedCompareQuery(compareCardQuery(agreed), 3)).toEqual(pagedCompareQuery(q, 3));
    expect(compareExportUrl(IDS, compareCardQuery(agreed), 'csv')).toBe(compareExportUrl(IDS, q, 'csv'));
    expect(compareExportFileName(agreed)).toBe('compare-fixed');
  });
});

describe('which screen the compare shows', () => {
  const loading: CompareState = { status: 'loading', query: null };

  it('is loading until there is an answer to draw', () => {
    expect(compareScreenOf(loading)).toBe('loading');
  });

  it('is the rows of a side that has some', () => {
    expect(compareScreenOf({ status: 'ready', data: response(), query: null })).toBe('rows');
  });

  it('is an empty side only when the totals say that side has nothing', () => {
    expect(compareScreenOf({ status: 'ready', data: response({ side: 'fixed', totals: { added: 2, fixed: 0, persisted: 3 } }), query: null })).toBe('empty-side');
    expect(compareScreenOf({ status: 'ready', data: response({ side: 'added', totals: { added: 2, fixed: 0, persisted: 3 } }), query: null })).toBe('rows');
  });

  it('is unavailable after a failed read, even with an answer to keep, and never an empty side', () => {
    const stale = response({ totals: { added: 0, fixed: 0, persisted: 0 } });
    expect(compareScreenOf({ status: 'failed', message: 'x', stale, query: null })).toBe('unavailable');
    expect(compareScreenOf({ status: 'failed', message: 'x', query: null })).toBe('unavailable');
  });

  it.each(['not-found', 'no-records', 'different-categories', 'bad-request'] as const)('is %s for the server\'s own refusal', code => {
    expect(compareScreenOf({ status: code, message: COMPARE_ERRORS[code].body.error, query: null })).toBe(code);
  });

  it('keeps drawing the last answer while the next is on its way', () => {
    const stale = response();
    expect(compareScreenOf({ status: 'loading', stale, query: null })).toBe('rows');
    expect(compareDataOf({ status: 'loading', stale, query: null })).toBe(stale);
    expect(compareDataOf({ status: 'failed', message: 'x', stale, query: null })).toBe(stale);
    expect(compareDataOf({ status: 'not-found', message: 'x', query: null })).toBeUndefined();
  });

  it('says which side is empty', () => {
    expect(emptySideMessage('fixed')).toBe('No fixed findings between these two scans.');
  });
});
