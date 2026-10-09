/**
 * ADR 0007: what a view reads from the database, not only what it answers (that is the parity
 * test's). A view must not load every finding with every row. The reads the server makes of
 * finding_rows are watched through lib/db/exec.ts, and every parse of a stored row is counted, over a
 * fixture of 1,100 findings with two rows each, which is more than two chunks of fingerprints:
 *
 *  - a view that looks at no row value reads only its page's first rows;
 *  - a view that filters on a returned column streams the rows: each chunk is parsed as it arrives,
 *    before the next one is read, and each candidate row is parsed once, unless its text cannot hold
 *    the filter's value, in which case it is not parsed at all;
 *  - a finding that fails two built-in filters can matter to no answer, so its rows are never read;
 *  - no read binds more fingerprints than one statement may.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';
import { CHUNK_SIZE } from '@/lib/db/chunk';
import { emptyView, rowField, type View, type ViewFilter } from '@/lib/finding-view';
import { rawGateOf } from '@/lib/view-pass';
import type { Finding } from '@/lib/types';

const events: string[] = [];
const reads: { params: unknown[] }[] = [];

vi.mock('@/lib/db/exec', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/db/exec')>();
  const many = ((query: { toSQL(): { sql: string; params: unknown[] } }) => {
    const { sql, params } = query.toSQL();
    if (/from "finding_rows"/i.test(sql)) {
      events.push('read');
      reads.push({ params });
    }
    return original.many(query as never);
  }) as unknown as typeof original.many;
  return { ...original, many };
});

const { queryColumnValues, queryGroup, queryView } = await import('@/lib/db/finding-views');

const FINDINGS = 1100;
const ROWS_EACH = 2;
const RULES = ['reads-sec', 'reads-cost'];
const realParse = JSON.parse;

let findings: (Finding & { rows: Record<string, unknown>[] })[] = [];

beforeAll(async () => {
  await resetDb();
  findings = Array.from({ length: FINDINGS }, (_, i) => syntheticFinding(
    `vm-${String(i).padStart(4, '0')}`,
    Array.from({ length: ROWS_EACH }, (_row, r) => ({ probeKey: 'p', zone: `z${(i + r) % 3}`, n: i })),
    { ruleId: RULES[i % 2]!, category: i % 2 === 0 ? 'security' : 'cost', severity: (i >> 1) % 2 === 0 ? 'high' : 'low' },
  ));
  for (const category of ['security', 'cost']) {
    await storeScan(findings.filter(f => f.category === category), { scanId: `scan-${category}`, category, finishedAt: new Date().toISOString() });
  }
});

beforeEach(() => {
  events.length = 0;
  reads.length = 0;
  // Only stored rows count: the probe key is in every one and in nothing else.
  vi.spyOn(JSON, 'parse').mockImplementation(((text: string, reviver?: (k: string, v: unknown) => unknown) => {
    if (typeof text === 'string' && text.includes('"probeKey"')) events.push('parse');
    return realParse(text, reviver);
  }) as typeof JSON.parse);
});
afterEach(() => { vi.restoreAllMocks(); });

const make = (patch: Partial<View> & { filters?: ViewFilter[] }): View => ({ ...emptyView(), ...patch });
const f = (field: ViewFilter['field'], ...values: string[]): ViewFilter => ({ field, values } as ViewFilter);
const parses = () => events.filter(e => e === 'parse').length;
const boundFingerprints = () => {
  const known = new Set(findings.map(x => x.fingerprint));
  return reads.flatMap(r => r.params.filter((p): p is string => typeof p === 'string' && known.has(p)));
};

describe('a view that looks at no row value', () => {
  it('reads only the rows of the findings on its page, and binds no more fingerprints than a statement may', async () => {
    const response = await queryView(make({}), { tab: 'results', showSuppressed: false });

    expect(response.items.length).toBe(50);
    expect(response.total).toBe(FINDINGS);
    expect(parses()).toBeLessThanOrEqual(50 * ROWS_EACH);
    expect(boundFingerprints().length).toBeLessThanOrEqual(50);
    expect(response.items.every(i => i.rowCount === ROWS_EACH && i.matchedRowCount === ROWS_EACH)).toBe(true);
  });

  it('reads no rows at all for a grouped view, whose answer is headers', async () => {
    const response = await queryView(make({ groupBy: ['category'] }), { tab: 'results', showSuppressed: false });

    expect(response.grouped?.rowTotal).toBe(FINDINGS * ROWS_EACH);
    expect(parses()).toBe(0);
  });
});

describe('a view that filters on a returned column', () => {
  // The empty value is one no row holds, and it keeps the cheap text test from skipping any row, so these
  // tests see every row parsed.
  const view = make({ filters: [f('row.zone', 'z1', '')] });

  it('parses each chunk of rows as it arrives, before the next chunk is read', async () => {
    await queryView(view, { tab: 'results', showSuppressed: false });

    const reading = events.map((e, i) => (e === 'read' ? i : -1)).filter(i => i >= 0);
    expect(reads.length).toBeGreaterThanOrEqual(3);
    // The second chunk is read only after every row of the first has been parsed.
    const firstChunk = reads[0]!.params.length;
    expect(events.slice(0, reading[1]!).filter(e => e === 'parse').length).toBeGreaterThanOrEqual(firstChunk * ROWS_EACH);
  });

  it('parses each candidate row once, then the rows of the page\'s findings again', async () => {
    const response = await queryView(view, { tab: 'results', showSuppressed: false });

    // Every finding is a candidate (no built-in filter), so the stream reads them all once.
    expect(parses()).toBeGreaterThanOrEqual(FINDINGS * ROWS_EACH);
    expect(parses()).toBeLessThanOrEqual(FINDINGS * ROWS_EACH + response.items.length * ROWS_EACH);
  });

  it('binds no more fingerprints in one read than a statement may', async () => {
    await queryView(view, { tab: 'results', showSuppressed: false });

    expect(Math.max(...reads.map(r => r.params.length))).toBeLessThanOrEqual(CHUNK_SIZE);
  });

  it('never reads a finding that fails two built-in filters', async () => {
    const filtered = make({ filters: [f('category', 'security'), f('severity', 'high'), f('row.zone', 'z1')] });
    await queryView(filtered, { tab: 'results', showSuppressed: false });

    const bound = new Set(boundFingerprints());
    const failsBoth = findings.filter(x => x.category !== 'security' && x.severity !== 'high');
    expect(failsBoth.length).toBeGreaterThan(0);
    expect(failsBoth.filter(x => bound.has(x.fingerprint))).toEqual([]);
    // And it does read the ones that fail one, whose facet and tile counts depend on them.
    expect(findings.filter(x => (x.category === 'security') !== (x.severity === 'high')).every(x => bound.has(x.fingerprint))).toBe(true);
  });

  it('reads only the filtered group\'s findings\' rows when one group is opened', async () => {
    const grouped = make({ groupBy: ['category'], filters: [f('category', 'cost'), f('row.zone', 'z1')] });
    await queryGroup(grouped, { tab: 'results', showSuppressed: false, groupPath: ['cost'], groupPage: 1 });

    const bound = new Set(boundFingerprints());
    expect(findings.filter(x => x.category === 'security' && bound.has(x.fingerprint))).toEqual([]);
  });

  it('reads only the opened group\'s findings\' rows when no built-in filter has already narrowed the view', async () => {
    const grouped = make({ groupBy: ['category'], filters: [f('row.zone', 'z1')] });
    await queryGroup(grouped, { tab: 'results', showSuppressed: false, groupPath: ['cost'], groupPage: 1 });

    const bound = new Set(boundFingerprints());
    expect(bound.size).toBeGreaterThan(0);
    expect(findings.filter(x => x.category === 'security' && bound.has(x.fingerprint))).toEqual([]);
  });
});

describe('a returned column\'s values', () => {
  it('parses every row of the findings the view lists once, and nothing else', async () => {
    const response = await queryColumnValues(make({ filters: [f('category', 'security')] }), { tab: 'results', showSuppressed: false, column: 'row.zone' });

    expect(response.values.length).toBe(3);
    expect(parses()).toBe(findings.filter(x => x.category === 'security').length * ROWS_EACH);
    expect(Math.max(...reads.map(r => r.params.length))).toBeLessThanOrEqual(CHUNK_SIZE);
  });
});

describe('a filter on a plain value', () => {
  it('parses only the rows whose text holds the value, and answers what the full parse answers', async () => {
    const plain = await queryView(make({ filters: [f('row.zone', 'z1')] }), { tab: 'results', showSuppressed: false });
    const parsedPlain = parses();
    events.length = 0;
    const full = await queryView(make({ filters: [f('row.zone', 'z1', '')] }), { tab: 'results', showSuppressed: false });

    expect(parsedPlain).toBeLessThan(FINDINGS * ROWS_EACH * 0.6);
    expect(plain).toEqual(full);
  });
});

describe('the text test run before a row is parsed', () => {
  const filter = (...values: string[]) => ({ field: rowField('zone'), values });

  it('has nothing to test for a value that could be written other ways, or none at all', () => {
    for (const values of [[''], ['3'], ['1e2'], ['12'], ['{"a":1}'], ['a/b'], ['caf\u00e9'], ['z1', ''], []]) {
      expect(rawGateOf([filter(...values)])).toBeUndefined();
    }
  });

  it('lets a row through when its text holds any one value, and stops one that holds none', () => {
    const gate = rawGateOf([filter('z1', 'West Europe')])!;
    expect(gate('{"zone":"z1","n":1}')).toBe(true);
    expect(gate('{"region":"West Europe"}')).toBe(true);
    expect(gate('{"zone":"z2"}')).toBe(false);
  });

  it('needs every filter to be met, and ignores a filter it cannot test', () => {
    const gate = rawGateOf([filter('z1'), { field: rowField('n'), values: ['7'] }, { field: rowField('tier'), values: ['Basic'] }])!;
    expect(gate('{"zone":"z1","tier":"Basic"}')).toBe(true);
    expect(gate('{"zone":"z1","tier":"Standard"}')).toBe(false);
    expect(gate('{"tier":"Basic"}')).toBe(false);
  });
});
