/**
 * ADR 0007: the server reads a returned column's values out of stored rows, so the values that are
 * hard to read must come out the way the explorer reads them. A fixture of findings whose rows hold
 * the awkward ones (quotes, backslashes, tabs, newlines, unicode, padded text, URLs, numbers,
 * booleans, null, empty text, arrays, objects, a text that reads like an array, a column whose key
 * contains a dot beside a nested one, differences of case, and a finding with more than a page of
 * rows) is answered by the four routes and by the pure reference, and the two are held equal for
 * every value the column holds as a filter, a sort, a group and an option list.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { referenceInputs, wire } from '../helpers/view-reference';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';
import { emptyView, valueText, viewToSearchParams, type View, type ViewFilter } from '@/lib/finding-view';
import {
  buildColumnValuesResponse, buildGroupResponse, buildViewResponse,
  type ColumnValuesResponse, type GroupResponse, type ViewResponse,
} from '@/lib/view-response';

const mockRequireRole = vi.fn();
vi.mock('@/lib/api-auth', () => ({ requireRole: (...args: unknown[]) => mockRequireRole(...args) }));
const viewRoute = await import('@/app/api/findings/view/route');
const groupRoute = await import('@/app/api/findings/group/route');
const columnValuesRoute = await import('@/app/api/findings/column-values/route');

/** Every kind of value a returned column can hold, as the row stores it. */
const AWKWARD: unknown[] = [
  'plain', 'Plain', 'PLAIN', 'He said "hi"', 'back\\slash', 'tab\there', 'multi\nline', 'ünï ✓ 日本 😀', ' padded ', '100%', 'a_b', 'it\'s',
  'https://x.example/a', '  https://x.example/a  ', 'https://x.example/a b', 'HTTP://UP.example/x', 'ftp://x.example',
  0, 1.5, -3, 1e21, true, false, null, '', { a: { b: 1 } }, [1, 2], [], {}, '[1,2]', '{"a":{"b":1}}', '5', 5, 'true', 'null',
];

const RULE = 'values-rule';
const OTHER_RULE = 'values-other';
const MANY = Array.from({ length: 45 }, (_, i) => ({ v: i % 2 ? 'odd' : 'even', n: i, w: `w${i % 4}` }));

beforeAll(async () => {
  await resetDb();
  const findings = [
    // Each awkward value, three to a finding, so findings hold several and share them.
    ...Array.from({ length: Math.ceil(AWKWARD.length / 3) }, (_, i) => syntheticFinding(
      `vm-values-${String(i).padStart(2, '0')}`,
      AWKWARD.slice(i * 3, i * 3 + 3).map((v, r) => ({ v, w: `w${(i + r) % 3}`, n: i * 3 + r, 'a.b': 'dotted', a: { b: `nested-${r}` }, deep: { x: { y: `y${i % 2}` } } })),
      { ruleId: RULE, severity: i % 2 ? 'high' : 'low', location: i % 3 ? 'westeurope' : 'northeurope' },
    )),
    syntheticFinding('vm-many-rows', MANY, { ruleId: RULE }),
    syntheticFinding('vm-no-rows', [], { ruleId: RULE }),
    syntheticFinding('vm-other', [{ v: 'plain', w: 'w0' }, { v: 'He said "hi"' }], { ruleId: OTHER_RULE, category: 'security', severity: 'medium' }),
  ];
  await storeScan(findings, { scanId: 'values-scan', finishedAt: new Date().toISOString() });
});

afterEach(() => { mockRequireRole.mockReset(); });

const make = (patch: Partial<View> & { filters?: ViewFilter[] }): View => ({ ...emptyView(), ...patch });
const f = (field: ViewFilter['field'], ...values: string[]): ViewFilter => ({ field, values } as ViewFilter);

async function call(route: { GET(req: Request): Promise<Response> }, name: string, view: View, params: Record<string, string>): Promise<Response> {
  mockRequireRole.mockResolvedValue({ id: 'viewer' });
  return route.GET(new Request(`http://localhost/api/findings/${name}?${viewToSearchParams(view, params)}`));
}

/** What each distinct value reads as, once, in the order the fixture holds them. */
const TEXTS = [...new Set(AWKWARD.map(valueText).filter(t => t !== ''))];

async function expectView(view: View): Promise<ViewResponse> {
  const res = await call(viewRoute, 'view', view, { tab: 'results' });
  expect(res.status).toBe(200);
  const body = await res.json() as ViewResponse;
  const { findings, options, ctx } = await referenceInputs('results', false);
  expect(body).toEqual(wire(buildViewResponse(findings, view, ctx, options)));
  return body;
}

describe('the fixture', () => {
  it('holds each awkward value in some finding, so no case below passes by matching nothing', async () => {
    const body = await expectView(make({}));
    // 12 findings of the awkward values, the one with 45 rows, the one with none, and the other rule's.
    expect(body.total).toBe(Math.ceil(AWKWARD.length / 3) + 3);
    expect(TEXTS.length).toBeGreaterThan(25);
  });
});

describe('a filter on one value of a returned column', () => {
  it.each(TEXTS.map(text => [JSON.stringify(text), text] as const))('%s', async (_label, text) => {
    const body = await expectView(make({ filters: [f('row.v', text)] }));
    expect(body.total).toBeGreaterThan(0);
  });

  it('two values at once', async () => {
    await expectView(make({ filters: [f('row.v', 'plain', 'He said "hi"')] }));
  });

  it('the blank value', async () => {
    const body = await expectView(make({ filters: [f('row.v', '')] }));
    expect(body.total).toBeGreaterThan(0);
  });

  it('a value and the blank value', async () => {
    await expectView(make({ filters: [f('row.v', '', 'odd')] }));
  });

  it('a filter with no value, which accepts everything', async () => {
    const body = await expectView(make({ filters: [f('row.v')] }));
    expect(body.total).toBeGreaterThan(10);
  });

  it('two columns, one of them nested', async () => {
    await expectView(make({ filters: [f('row.v', 'odd'), f('row.deep.x.y', 'y0')] }));
  });

  it('a column whose key holds a dot, which wins over the nested reading', async () => {
    const dotted = await expectView(make({ filters: [f('row.a.b', 'dotted')] }));
    expect(dotted.total).toBeGreaterThan(0);
    await expectView(make({ filters: [f('row.a.b', 'nested-0')] }));
  });

  it('a value that differs from another only by case', async () => {
    const lower = await expectView(make({ filters: [f('row.v', 'plain')] }));
    const upper = await expectView(make({ filters: [f('row.v', 'PLAIN')] }));
    expect(upper.total).toBeLessThan(lower.total + upper.total);
  });

  it('a value filter beside a built-in one and a search', async () => {
    await expectView(make({ filters: [f('row.v', 'plain'), f('severity', 'high')], search: 'VALUES' }));
  });
});

describe('sorting and grouping by a returned column', () => {
  it.each([
    ['sort by the awkward column, ascending', make({ sort: { field: 'row.v', dir: 'asc' } })],
    ['sort by the awkward column, descending', make({ sort: { field: 'row.v', dir: 'desc' } })],
    ['sort by a number', make({ sort: { field: 'row.n', dir: 'asc' } })],
    ['sort by a number, descending', make({ sort: { field: 'row.n', dir: 'desc' } })],
    ['sort by a column some rows lack', make({ sort: { field: 'row.deep.x.y', dir: 'asc' } })],
    ['sort by a filtered column', make({ filters: [f('row.v', 'odd', 'plain')], sort: { field: 'row.n', dir: 'desc' } })],
    ['group by the awkward column', make({ groupBy: ['row.v'] })],
    ['group by it, groups by count', make({ groupBy: ['row.v'], groupSort: { by: 'count', dir: 'desc' } })],
    ['group by it, descending', make({ groupBy: ['row.v'], groupSort: { by: 'value', dir: 'desc' } })],
    ['group by two columns', make({ groupBy: ['row.v', 'row.w'] })],
    ['group by a column and a built-in field', make({ groupBy: ['row.w', 'severity'] })],
    ['group by a built-in field and a column', make({ groupBy: ['severity', 'row.v'] })],
    ['group by a column, filtered on another', make({ groupBy: ['row.v'], filters: [f('row.w', 'w1')] })],
    ['group by a column, filtered on the same one', make({ groupBy: ['row.v'], filters: [f('row.v', 'odd', 'even')] })],
    ['group by a column, sorted by another', make({ groupBy: ['row.w'], sort: { field: 'row.n', dir: 'desc' } })],
    ['group by a dotted column', make({ groupBy: ['row.a.b'] })],
  ])('%s', async (_name, view) => {
    await expectView(view);
  });
});

describe('opening a group of a returned column', () => {
  it.each(TEXTS.map(text => [JSON.stringify(text), text] as const))('the group of %s', async (_label, text) => {
    const view = make({ groupBy: ['row.v'] });
    const res = await call(groupRoute, 'group', view, { tab: 'results', groupPath: JSON.stringify([text]) });
    expect(res.status).toBe(200);
    const body = await res.json() as GroupResponse;
    const { findings, options, ctx } = await referenceInputs('results', false);
    expect(body).toEqual(wire(buildGroupResponse(findings, view, ctx, { ...options, groupPath: [text], groupPage: 1 })));
    expect(body.group).not.toBeNull();
  });

  it.each([
    ['the empty-value group', make({ groupBy: ['row.v'] }), [null]],
    ['a group below another column\'s', make({ groupBy: ['row.w', 'row.v'] }), ['w1', 'odd']],
    ['a group below a built-in field\'s', make({ groupBy: ['severity', 'row.v'] }), ['low', 'plain']],
    ['a column group with a filter on the same column', make({ groupBy: ['row.v'], filters: [f('row.v', 'odd', 'even')] }), ['odd']],
    ['the group that holds the finding with 45 rows', make({ groupBy: ['row.w'] }), ['w2']],
    ['the same, sorted by a returned number', make({ groupBy: ['row.w'], sort: { field: 'row.n', dir: 'desc' } }), ['w2']],
  ])('%s', async (_name, view, path) => {
    const res = await call(groupRoute, 'group', view, { tab: 'results', groupPath: JSON.stringify(path) });
    const body = await res.json() as GroupResponse;
    const { findings, options, ctx } = await referenceInputs('results', false);
    expect(body).toEqual(wire(buildGroupResponse(findings, view, ctx, { ...options, groupPath: path, groupPage: 1 })));
    expect(body.group).not.toBeNull();
  });
});

describe('the option list of a returned column', () => {
  it.each([
    ['the awkward column', 'row.v', undefined, make({})],
    ['a search that matches a few', 'row.v', 'pl', make({})],
    ['a search in capitals', 'row.v', 'HE SAID', make({})],
    ['a search for a percent sign', 'row.v', '%', make({})],
    ['a search for an underscore', 'row.v', '_', make({})],
    ['a search for a quote', 'row.v', '"', make({})],
    ['a search for a backslash', 'row.v', '\\', make({})],
    ['a dotted column', 'row.a.b', undefined, make({})],
    ['a nested column', 'row.deep.x.y', undefined, make({})],
    ['a number column', 'row.n', undefined, make({})],
    ['a filter on this column, which hides nothing', 'row.v', undefined, make({ filters: [f('row.v', 'odd')] })],
    ['a filter on another column', 'row.v', undefined, make({ filters: [f('row.w', 'w1')] })],
    ['a blank filter on another column', 'row.v', undefined, make({ filters: [f('row.w', '')] })],
    ['a built-in filter', 'row.v', undefined, make({ filters: [f('severity', 'high')] })],
    ['a view search', 'row.v', undefined, make({ search: 'many' })],
  ])('%s', async (_name, column, valueQuery, view) => {
    const res = await call(columnValuesRoute, 'column-values', view, { tab: 'results', column, ...(valueQuery !== undefined ? { valueQuery } : {}) });
    expect(res.status).toBe(200);
    const body = await res.json() as ColumnValuesResponse;
    const { findings, ctx } = await referenceInputs('results', false);
    expect(body).toEqual(wire(buildColumnValuesResponse(findings, view, ctx, { tab: 'results', column: column as `row.${string}`, q: valueQuery })));
  });

  it('counts a finding once for a value it holds in several rows', async () => {
    const body = await (await call(columnValuesRoute, 'column-values', make({ filters: [f('rule', RULE)] }), { tab: 'results', column: 'row.v' })).json() as ColumnValuesResponse;
    // vm-many-rows holds 'odd' in 22 rows and 'even' in 23, and counts once for each.
    expect(body.values.find(v => v.value === 'odd')?.count).toBe(1);
    expect(body.values.find(v => v.value === 'even')?.count).toBe(1);
  });
});
