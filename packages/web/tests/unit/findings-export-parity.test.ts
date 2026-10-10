/**
 * ADR 0007: the export route writes the file the explorer's own routes describe. For one query string it
 * holds every finding the view route lists, in its order, with every row the view's row filters let
 * through (the rows route's pages, added up), and the file is what `buildFindingsCsv` and
 * `buildFindingsJson` write for exactly those findings. The oracle here is those routes, not a second
 * copy of the view's logic.
 *
 * The fixture is stored through runCategoryScan() over the fake Azure context, so findings, rows and
 * ages are what a real scan leaves, plus two synthetic rules for what a scan of this size is slow to
 * make: one finding with more rows than a read block holds, and more findings than a read holds.
 */
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { computeFingerprint } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { findingRows as findingRowsTable, rules as rulesTable } from '@/lib/db/tables';
import { getCategory } from '@/lib/db/categories';
import { EXPORT_BATCH_FINDINGS, EXPORT_BATCH_ROWS, EXPORT_ROW_BLOCK, planExportReads } from '@/lib/db/finding-views';
import { FINDING_ROWS_COPY_MARKER } from '@/lib/db/finding-rows-copy';
import { deleteMeta, getMeta, setMeta } from '@/lib/db/meta';
import { buildFindingsCsv, buildFindingsJson, type HeldFinding } from '@/lib/findings-export';
import { addSuppression } from '@/lib/suppressions';
import { runCategoryScan } from '@/lib/scan-runner';
import { emptyView, viewToSearchParams, type View, type ViewFilter } from '@/lib/finding-view';
import type { FindingRowsResponse, ViewResponse, ViewTab } from '@/lib/view-response';
import { resetDb } from '../helpers/db';
import { argRow, fakeTenantContext, TEST_SUB_A, TEST_SUB_B } from '../helpers/fake-azure';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';

const mockRequireRole = vi.fn();
vi.mock('@/lib/api-auth', () => ({ requireRole: (...args: unknown[]) => mockRequireRole(...args) }));
const viewRoute = await import('@/app/api/findings/view/route');
const rowsRoute = await import('@/app/api/findings/rows/route');
const exportRoute = await import('@/app/api/findings/export/route');

// ---- The fixture ----

const NOW = Date.now();
const DAY = 86_400_000;
const AT = { T0: NOW - 20 * DAY, T2: NOW - 0.5 * DAY } as const;
type Moment = keyof typeof AT;

interface Resource { name: string; sub?: string; rg?: string; rows: Record<string, unknown>[] }
const vm = (name: string, rows: Record<string, unknown>[], rest: Partial<Resource> = {}): Resource => ({ name, rows, ...rest });

const MANY_ROWS = Array.from({ length: 25 }, (_, i) => ({ item: i, zone: String(1 + (i % 3)) }));
const ALPHA_ROWS = [{ zone: '1', sku: 'S1', owner: 'a,b' }, { zone: '2', sku: 'S2' }];
const BRAVO_ROWS = [{ zone: '3', sku: 'S1', note: 'say "hi"' }];

interface RulePlan { name: string; category: 'security' | 'reliability'; severity: string; kind: 'state' | 'advisory'; tags?: string[]; at: Partial<Record<Moment, Resource[]>> }
const PLANS: Record<string, RulePlan> = {
  'exp-high': {
    name: 'Basic tier retirements', category: 'security', severity: 'high', kind: 'state', tags: ['prod'],
    at: {
      T0: [vm('vm-alpha', ALPHA_ROWS), vm('vm-bravo', BRAVO_ROWS, { sub: TEST_SUB_B, rg: 'rg-b' })],
      T2: [vm('vm-alpha', ALPHA_ROWS), vm('vm-bravo', BRAVO_ROWS, { sub: TEST_SUB_B, rg: 'rg-b' }), vm('vm-charlie', [{ zone: '1', sku: 'S2' }]), vm('vm-delta', MANY_ROWS)],
    },
  },
  'exp-critical': {
    name: 'Critical exposure', category: 'security', severity: 'critical', kind: 'state',
    at: { T0: [vm('vm-alpha', [{ zone: '1' }])], T2: [vm('vm-alpha', [{ zone: '1' }]), vm('vm-echo', [{ zone: '2', nested: { deep: 1 }, list: [1, 2] }])] },
  },
  'exp-advice': {
    name: 'Service retirements', category: 'reliability', severity: 'medium', kind: 'advisory',
    at: { T2: [vm('vm-ivy', [{ retirement: 'Basic tier' }, { retirement: 'Gen1 images' }], { rg: 'rg-d' })] },
  },
};
// Fixed sizes, not derived from the limits under test: a limit changed by mistake must not resize the fixture.
// The tests below assert each size still exceeds the limit it is there to exceed.
const BIG = { rule: 'exp-big', rows: 1007 };
const MANY = { rule: 'exp-many', findings: 520 };

const baseRule = {
  description: 'test rule', enabled: true, scope: JSON.stringify({ level: 'subscription' }),
  resourceTypes: JSON.stringify([]), conditions: JSON.stringify([]), type: 'custom',
};

async function scanAt(moment: Moment): Promise<void> {
  const rowsFor = (kql: string) => {
    const id = Object.keys(PLANS).find(rule => kql.endsWith(`// ${rule}`));
    return (id ? PLANS[id]!.at[moment] ?? [] : []).flatMap(res => res.rows.map(extra => argRow({
      name: res.name, subscriptionId: res.sub ?? TEST_SUB_A, resourceGroup: res.rg ?? 'rg-a', ...extra,
    })));
  };
  for (const categoryId of ['security', 'reliability'] as const) {
    const ruleIds = Object.entries(PLANS).filter(([, plan]) => plan.category === categoryId).map(([id]) => id);
    await runCategoryScan((await getCategory(categoryId))!, {
      ctx: fakeTenantContext({ rows: rowsFor, subscriptionIds: [TEST_SUB_A, TEST_SUB_B] }), ruleIds, now: new Date(AT[moment]),
    });
  }
}

beforeAll(async () => {
  await resetDb();
  for (const [id, plan] of Object.entries(PLANS)) {
    await execRun(db.delete(rulesTable).where(eq(rulesTable.id, id)));
    await execRun(db.insert(rulesTable).values({
      ...baseRule, id, name: plan.name, category: plan.category, severity: plan.severity, kind: plan.kind,
      rawKql: `resources | where type == "microsoft.compute/virtualmachines" // ${id}`, tags: plan.tags ? JSON.stringify(plan.tags) : null,
    }));
  }
  await scanAt('T0');
  await scanAt('T2');
  const resourceId = String(argRow({ name: 'vm-bravo', subscriptionId: TEST_SUB_B, resourceGroup: 'rg-b' }).id);
  await addSuppression({ id: 'sup-bravo', fingerprint: computeFingerprint('exp-high', resourceId), reason: 'Accepted', suppressedAt: new Date(AT.T0).toISOString() });

  const finishedAt = new Date(AT.T2).toISOString();
  await storeScan([
    // The last row alone carries a key, so the header of the file depends on a row read in the last block.
    syntheticFinding('vm-big', Array.from({ length: BIG.rows }, (_, n) => ({ n, zone: String(1 + (n % 3)), ...(n === BIG.rows - 1 ? { late: 'yes' } : {}) })), { ruleId: BIG.rule }),
  ], { scanId: 'scan-big', finishedAt });
  await storeScan(
    Array.from({ length: MANY.findings }, (_, i) => syntheticFinding(`many-${String(i).padStart(4, '0')}`, [{ part: 'a', n: i }, { part: 'b', n: i }], { ruleId: MANY.rule })),
    { scanId: 'scan-many', finishedAt },
  );
});

afterEach(() => { mockRequireRole.mockReset(); });

// ---- The oracle: the explorer's own routes ----

const make = (patch: Partial<View> = {}): View => ({ ...emptyView(), ...patch });
const f = (field: ViewFilter['field'], ...values: string[]): ViewFilter => ({ field, values } as ViewFilter);

/** Every finding the view route lists for the query, one page after another, each with all its matched
 *  rows, the rows route's pages added up when the first page of them held fewer. */
async function findingsOfViewRoute(query: URLSearchParams): Promise<HeldFinding[]> {
  mockRequireRole.mockResolvedValue({ id: 'viewer' });
  const out: HeldFinding[] = [];
  for (let page = 1; ; page++) {
    const params = new URLSearchParams(query);
    params.set('page', String(page));
    const first = await (await viewRoute.GET(new Request(`http://localhost/api/findings/view?${params}`))).json() as ViewResponse;
    for (const item of first.items) {
      const rows = [...item.rows];
      for (let rowsPage = 2; rows.length < item.matchedRowCount; rowsPage++) {
        const rowParams = new URLSearchParams(query);
        rowParams.set('fingerprint', item.finding.fingerprint);
        rowParams.set('rowsPage', String(rowsPage));
        const more = await (await rowsRoute.GET(new Request(`http://localhost/api/findings/rows?${rowParams}`))).json() as FindingRowsResponse;
        if (more.rows.length === 0) break;
        rows.push(...more.rows);
      }
      out.push({ ...item.finding, rows, evidence: rows[0] ?? {} } as HeldFinding);
    }
    if (page >= first.pageCount) return out;
  }
}

async function getExport(query: URLSearchParams, format: 'csv' | 'json'): Promise<Response> {
  mockRequireRole.mockResolvedValue({ id: 'viewer' });
  return exportRoute.GET(new Request(`http://localhost/api/findings/export?${query}&format=${format}`));
}

const queryOf = (view: View, tab: ViewTab = 'results', suppressed = false) => viewToSearchParams(view, { tab, ...(suppressed ? { suppressed: '1' } : {}) });

// ---- The views ----

interface Case { name: string; view: View; tab?: ViewTab; suppressed?: boolean }
const CASES: Case[] = [
  { name: 'the default view', view: make() },
  { name: 'a row filter, which limits the rows each finding writes', view: make({ filters: [f('row.zone', '1')] }) },
  { name: 'two row filters and a built-in one', view: make({ filters: [f('severity', 'high'), f('row.zone', '1', '2'), f('row.sku', 'S1', 'S2')] }) },
  { name: 'a row filter no finding passes', view: make({ filters: [f('row.zone', 'nowhere')] }) },
  { name: 'search and a sort on a built-in column', view: make({ search: 'vm-', sort: { field: 'resourceName', dir: 'desc' } }) },
  { name: 'search and a sort on a returned column', view: make({ search: 'alpha', sort: { field: 'row.zone', dir: 'desc' } }) },
  { name: 'a sort on a returned column after a row filter', view: make({ filters: [f('row.zone', '1', '3')], sort: { field: 'row.item', dir: 'desc' } }) },
  { name: 'a window with the New status', view: make({ filters: [f('status', 'new')], window: { mode: 'relative', days: 1 } }) },
  { name: 'every status over a long window', view: make({ filters: [f('status', 'all')], window: { mode: 'relative', days: 365 } }) },
  { name: 'suppressed findings shown', view: make({ filters: [f('status', 'all')] }), suppressed: true },
  { name: 'the Advisories tab', view: make(), tab: 'advisories' },
  { name: 'search that matches nothing', view: make({ search: 'zzz-no-such' }) },
  { name: 'a rule whose one finding holds more rows than a read block', view: make({ filters: [f('rule', BIG.rule)] }) },
  { name: 'a row filter on that finding', view: make({ filters: [f('rule', BIG.rule), f('row.zone', '2')] }) },
  { name: 'more findings than one read holds, in order', view: make({ filters: [f('rule', MANY.rule)], sort: { field: 'resourceName', dir: 'desc' } }) },
  { name: 'every finding of both rules', view: make({ filters: [f('rule', BIG.rule, MANY.rule, 'exp-high')], sort: { field: 'row.n', dir: 'asc' } }) },
];

describe('the export route writes the findings the view route lists', () => {
  describe.each(CASES)('$name', ({ view, tab, suppressed }) => {
    it('as the CSV buildFindingsCsv writes, a line a row', async () => {
      const query = queryOf(view, tab, suppressed);
      const expected = await findingsOfViewRoute(query);
      const res = await getExport(query, 'csv');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(buildFindingsCsv(expected));
    });

    it('as the JSON buildFindingsJson writes', async () => {
      const query = queryOf(view, tab, suppressed);
      const expected = await findingsOfViewRoute(query);
      const res = await getExport(query, 'json');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(buildFindingsJson(expected));
    });
  });

  it('finds findings in these cases at all (the table is not comparing empty files)', async () => {
    const sizes = await Promise.all(CASES.slice(0, 3).map(async c => (await findingsOfViewRoute(queryOf(c.view, c.tab, c.suppressed))).length));
    expect(sizes.every(n => n > 0)).toBe(true);
  });

  it('writes one CSV line per matched row, the row filter keeping only the rows that pass it', async () => {
    const query = queryOf(make({ filters: [f('rule', 'exp-high'), f('row.zone', '1')] }));
    const lines = (await (await getExport(query, 'csv')).text()).split('\n');
    const expected = await findingsOfViewRoute(query);
    expect(lines).toHaveLength(1 + expected.reduce((n, finding) => n + (finding.rows?.length ?? 0), 0));
    // vm-alpha holds a zone 1 row and a zone 2 row, vm-delta a third of its 25 rows, vm-charlie one.
    expect(expected.map(e => [e.resourceName, e.rows?.length])).toEqual(expect.arrayContaining([['vm-alpha', 1], ['vm-delta', 9], ['vm-charlie', 1]]));
  });

  it('ignores grouping: a grouped view exports the same findings, in the same order, as the ungrouped one', async () => {
    const plain = await (await getExport(queryOf(make({ filters: [f('rule', 'exp-high')] })), 'csv')).text();
    const grouped = await (await getExport(queryOf(make({ filters: [f('rule', 'exp-high')], groupBy: ['category'] })), 'csv')).text();
    expect(grouped).toBe(plain);
  });

  it('ignores the page and the page size, which are the explorer\'s own', async () => {
    const query = queryOf(make({ filters: [f('rule', MANY.rule)] }));
    const all = await (await getExport(query, 'csv')).text();
    const paged = new URLSearchParams(query);
    paged.set('page', '3');
    paged.set('pageSize', '10');
    expect(await (await getExport(paged, 'csv')).text()).toBe(all);
  });
});

describe('a finding with more rows than one page holds, or one read block', () => {
  const query = queryOf(make({ filters: [f('rule', BIG.rule)] }));

  it('exports every row, in query order, as CSV', async () => {
    const lines = (await (await getExport(query, 'csv')).text()).split('\n');
    expect(BIG.rows).toBeGreaterThan(20);
    expect(BIG.rows).toBeGreaterThan(EXPORT_ROW_BLOCK);
    expect(lines).toHaveLength(1 + BIG.rows);
    const header = lines[0]!.split(',');
    expect(header).toContain('late');
    const nColumn = header.indexOf('n');
    expect(lines.slice(1).map(line => Number(line.split(',')[nColumn]))).toEqual(Array.from({ length: BIG.rows }, (_, n) => n));
  });

  it('exports every row, in query order, as one finding of JSON', async () => {
    const parsed = JSON.parse(await (await getExport(query, 'json')).text()) as { rows: { n: number }[]; evidence: { n: number } }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.rows.map(r => r.n)).toEqual(Array.from({ length: BIG.rows }, (_, n) => n));
    expect(parsed[0]!.evidence.n).toBe(0);
  });

  it('exports the rows a filter passes from every block', async () => {
    const filtered = queryOf(make({ filters: [f('rule', BIG.rule), f('row.zone', '3')] }));
    const parsed = JSON.parse(await (await getExport(filtered, 'json')).text()) as { rows: { n: number }[] }[];
    const wanted = Array.from({ length: BIG.rows }, (_, n) => n).filter(n => n % 3 === 2);
    expect(parsed[0]!.rows.map(r => r.n)).toEqual(wanted);
    expect(wanted.length).toBeGreaterThan(EXPORT_ROW_BLOCK / 3 * 2);
  });
});

describe('a large result', () => {
  const query = queryOf(make({ filters: [f('rule', MANY.rule)], sort: { field: 'resourceName', dir: 'asc' } }));
  const last = `many-${String(MANY.findings - 1).padStart(4, '0')}`;

  it.each(['csv', 'json'] as const)('starts as %s before its last finding has been read, and the rest follows', async (format) => {
    const res = await getExport(query, format);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    expect(MANY.findings).toBeGreaterThan(EXPORT_BATCH_FINDINGS);
    expect(first).toContain('many-0000');
    expect(first).not.toContain(last);
    let rest = '';
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest += decoder.decode(r.value);
    expect(rest).toContain(last);
    // Two findings of two rows each, repeated for every finding of the rule, in one file.
    const file = first + rest;
    expect(file.match(/many-\d{4}/g)!.length).toBeGreaterThanOrEqual(MANY.findings);
  });
});

describe('the files, to the letter', () => {
  const PINNED = 'exp-pinned';
  const SCANNED_AT = '2026-03-01T10:00:00.000Z';

  beforeAll(async () => {
    await storeScan([syntheticFinding('vm-pin', [{ owner: 'a,b', zone: '1' }, { owner: 'c', zone: '2' }], { ruleId: PINNED })], { scanId: 'scan-pin', finishedAt: SCANNED_AT });
  });

  const pinned = queryOf(make({ filters: [f('rule', PINNED), f('status', 'all')], window: { mode: 'relative', days: 3650 } }));

  it('has this CSV header and these data lines', async () => {
    const lines = (await (await getExport(pinned, 'csv')).text()).split('\n');
    expect(lines[0]).toBe('Severity,Title,Resource,ResourceGroup,Location,Subscription,ResourceType,RuleId,Violation,DetectedAt,PortalLink,Status,FirstSeen,LastSeen,TimesSeen,owner,zone');
    const fixed = 'high,Finding of exp-pinned,vm-pin,rg-1,westeurope,sub-1,microsoft.compute/virtualmachines,exp-pinned,,';
    const ages = `${SCANNED_AT},,active,${SCANNED_AT},${SCANNED_AT},1`;
    expect(lines.slice(1)).toEqual([`${fixed}${ages},"a,b",1`, `${fixed}${ages},c,2`]);
  });

  it('has this JSON, with the rows beside the finding\'s own fields and the first row as its evidence', async () => {
    const [finding] = JSON.parse(await (await getExport(pinned, 'json')).text()) as Record<string, unknown>[];
    expect(Object.keys(finding!).slice(-4)).toEqual(['ruleDisabled', 'ruleTags', 'rows', 'evidence']);
    expect(finding).toMatchObject({
      ruleId: PINNED, resourceName: 'vm-pin', severity: 'high', status: 'active', timesSeen: 1,
      rows: [{ owner: 'a,b', zone: '1' }, { owner: 'c', zone: '2' }], evidence: { owner: 'a,b', zone: '1' },
    });
  });

  it('answers with the headers a download needs', async () => {
    const csv = await getExport(pinned, 'csv');
    expect(csv.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(csv.headers.get('Content-Disposition')).toBe('attachment; filename="findings.csv"');
    expect(csv.headers.get('Cache-Control')).toBe('no-store');
    // An export holds the database's read lock until its body is read or cancelled, on SQLite.
    await csv.body?.cancel();
    const json = await getExport(pinned, 'json');
    expect(json.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(json.headers.get('Content-Disposition')).toBe('attachment; filename="findings.json"');
    await json.body?.cancel();
  });
});

describe('before the upgrade\'s copy into finding_rows has been proven', () => {
  const views = [
    make({ filters: [f('rule', 'exp-high', 'exp-critical')], sort: { field: 'resourceName', dir: 'asc' } }),
    make({ filters: [f('rule', 'exp-high'), f('row.zone', '1')] }),
    make({ search: 'alpha', sort: { field: 'row.zone', dir: 'desc' } }),
  ];
  let marker = '';
  const before: string[] = [];

  beforeAll(async () => {
    for (const view of views) for (const format of ['csv', 'json'] as const) before.push(await (await getExport(queryOf(view), format)).text());
    marker = (await getMeta(FINDING_ROWS_COPY_MARKER))!;
    // What the scan stored in finding_rows is gone, so only the old columns still hold the rows.
    await execRun(db.delete(findingRowsTable));
    await deleteMeta(FINDING_ROWS_COPY_MARKER);
  });

  it('writes the same files from the old row columns', async () => {
    const after: string[] = [];
    for (const view of views) for (const format of ['csv', 'json'] as const) after.push(await (await getExport(queryOf(view), format)).text());
    expect(after).toEqual(before);
    expect(before.every(text => text.length > 10)).toBe(true);
  });

  it('is put back for what follows', async () => {
    await setMeta(FINDING_ROWS_COPY_MARKER, marker);
    expect(await getMeta(FINDING_ROWS_COPY_MARKER)).toBe(marker);
  });
});

describe('how the findings are split into reads', () => {
  const counts = (entries: Record<string, number>) => new Map(Object.entries(entries));

  it('keeps findings together while they stay under the limits, in order', () => {
    expect(planExportReads(['a', 'b', 'c'], counts({ a: 3, b: 0, c: 7 }))).toEqual([{ fingerprints: ['a', 'b', 'c'] }]);
    expect(planExportReads([], counts({}))).toEqual([]);
  });

  it('starts a new read at the most findings one read holds', () => {
    const fingerprints = Array.from({ length: EXPORT_BATCH_FINDINGS + 1 }, (_, n) => `f${n}`);
    const reads = planExportReads(fingerprints, counts({}));
    expect(reads.map(r => ('fingerprints' in r ? r.fingerprints.length : 0))).toEqual([EXPORT_BATCH_FINDINGS, 1]);
  });

  it('starts a new read at the most rows one read holds', () => {
    const each = EXPORT_ROW_BLOCK;
    const fit = EXPORT_BATCH_ROWS / each;
    const fingerprints = Array.from({ length: fit + 1 }, (_, n) => `f${n}`);
    const reads = planExportReads(fingerprints, new Map(fingerprints.map(f => [f, each])));
    expect(reads.map(r => ('fingerprints' in r ? r.fingerprints.length : 0))).toEqual([fit, 1]);
  });

  it('reads a finding with more rows than a block alone, between the reads of the findings around it', () => {
    expect(planExportReads(['a', 'big', 'c', 'd'], counts({ a: 1, big: EXPORT_ROW_BLOCK + 1, c: 1, d: 1 }))).toEqual([
      { fingerprints: ['a'] }, { block: 'big' }, { fingerprints: ['c', 'd'] },
    ]);
    // A finding of exactly one block is still read with the rest.
    expect(planExportReads(['a', 'b'], counts({ a: EXPORT_ROW_BLOCK, b: 1 }))).toEqual([{ fingerprints: ['a', 'b'] }]);
  });
});
