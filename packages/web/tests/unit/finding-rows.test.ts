/**
 * The pure rules behind "a finding keeps every row" (issue #192): how a finding's rows are
 * resolved for reading, and how findings sharing a fingerprint fold into one.
 */
import { describe, expect, it } from 'vitest';
import { findingRows, mergeFindingsByFingerprint, pageFindingRows, rowKey, ROWS_PER_PAGE } from '@/lib/finding-rows';

describe('rowKey', () => {
  it('is the same for rows equal at every level whatever their key order, and differs otherwise', () => {
    expect(rowKey({ a: 1, b: { y: [1, { q: 1, p: 2 }], x: null } })).toBe(rowKey({ b: { x: null, y: [1, { p: 2, q: 1 }] }, a: 1 }));
    expect(rowKey({ a: 1 })).not.toBe(rowKey({ a: '1' }));
    expect(rowKey({ a: [1, 2] })).not.toBe(rowKey({ a: [2, 1] }));
    expect(rowKey({ a: undefined, b: 1 })).toBe(rowKey({ b: 1 }));
  });
});

const f = (fingerprint: string, evidence: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ fingerprint, evidence, title: '', ...extra });

describe('findingRows', () => {
  it('returns the stored rows as they are', () => {
    expect(findingRows({ evidence: { a: 1 }, rows: [{ a: 1 }, { a: 2 }] })).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('reads a finding with no stored rows as one row made from its evidence', () => {
    expect(findingRows({ evidence: { a: 1 } })).toEqual([{ a: 1 }]);
    expect(findingRows({ evidence: { a: 1 }, rows: null })).toEqual([{ a: 1 }]);
  });

  it('reads a finding with neither rows nor evidence as no rows', () => {
    expect(findingRows({ evidence: {} })).toEqual([]);
    expect(findingRows({})).toEqual([]);
  });
});

describe('mergeFindingsByFingerprint', () => {
  it('folds findings with one fingerprint into one holding every row in arrival order, keeping first-seen order', () => {
    const merged = mergeFindingsByFingerprint([
      f('x', { n: 1 }), f('y', { n: 2 }), f('x', { n: 3 }), f('x', { n: 4 }),
    ]);
    expect(merged.map(m => m.fingerprint)).toEqual(['x', 'y']);
    expect(merged[0]!.rows).toEqual([{ n: 1 }, { n: 3 }, { n: 4 }]);
    expect(merged[0]!.evidence).toEqual({ n: 1 });
    expect(merged[1]!.rows).toEqual([{ n: 2 }]);
  });

  it('takes the display fields from the last occurrence', () => {
    const [only] = mergeFindingsByFingerprint([f('x', { n: 1 }, { title: 'first' }), f('x', { n: 2 }, { title: 'last' })]);
    expect(only!.title).toBe('last');
  });

  it('collapses identical rows to one, keeping the first occurrence and query order, whatever the key order', () => {
    const [only] = mergeFindingsByFingerprint([
      f('x', { a: 1, b: { d: 4, c: 3 } }),
      f('x', { n: 2 }),
      f('x', { b: { c: 3, d: 4 }, a: 1 }),
      f('x', { n: 2 }),
    ]);
    expect(only!.rows).toHaveLength(2);
    expect(JSON.stringify(only!.rows[0])).toBe('{"a":1,"b":{"d":4,"c":3}}');
    expect(only!.rows[1]).toEqual({ n: 2 });
    expect(only!.evidence).toBe(only!.rows[0]);
  });

  it('keeps rows that differ in a value, an extra key or an array order', () => {
    const [only] = mergeFindingsByFingerprint([
      f('x', { n: 1 }), f('x', { n: 2 }), f('x', { n: 1, m: null }), f('x', { t: [1, 2] }), f('x', { t: [2, 1] }),
    ]);
    expect(only!.rows).toHaveLength(5);
  });

  it('gives a finding with empty evidence no rows', () => {
    const [only] = mergeFindingsByFingerprint([f('x', {}), f('x', {})]);
    expect(only!.rows).toEqual([]);
    expect(only!.evidence).toEqual({});
  });

  it('merges findings that already hold rows', () => {
    const [only] = mergeFindingsByFingerprint([
      f('x', { n: 1 }, { rows: [{ n: 1 }, { n: 2 }] }), f('x', { n: 3 }),
    ]);
    expect(only!.rows).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });
});

describe('pageFindingRows', () => {
  const rows = Array.from({ length: 45 }, (_, i) => ({ n: i }));

  it('keeps every row and hands out one page of them at a time', () => {
    const first = pageFindingRows(rows, 1);
    expect(first).toMatchObject({ page: 1, pageCount: 3, total: 45, firstIndex: 0 });
    expect(first.rows).toEqual(rows.slice(0, ROWS_PER_PAGE));
    const last = pageFindingRows(rows, 3);
    expect(last.rows).toEqual(rows.slice(2 * ROWS_PER_PAGE));
    expect(last.firstIndex).toBe(2 * ROWS_PER_PAGE);
  });

  it('clamps a page past either end to the nearest real one', () => {
    expect(pageFindingRows(rows, 9).page).toBe(3);
    expect(pageFindingRows(rows, 0).page).toBe(1);
    expect(pageFindingRows([], 4)).toMatchObject({ rows: [], page: 1, pageCount: 1, total: 0 });
  });
});
