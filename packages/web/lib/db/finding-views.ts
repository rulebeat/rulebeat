/**
 * The server side of a view (ADR 0007): what the explorer used to compute in the browser over every
 * finding, answered from the database. Each function runs in one read transaction, so the findings,
 * rules, suppressions, categories and column catalogue it combines are one moment of the database,
 * and returns what lib/view-response.ts's pure reference returns over the same findings.
 *
 * It never loads every finding with every row. Reading a finding's rows is most of what listing
 * findings costs, and most views never look at them:
 *
 *  1. The tab's findings are read once without rows or long text (`SlimFinding`).
 *  2. A view with no filter, sort or group on a returned column needs no row at all. A grouped one
 *     needs how many rows each finding has, which the rows table's key index counts.
 *  3. A view that does look at rows streams them: a chunk of fingerprints at a time, each stored row
 *     parsed once, tested against the row filters and reduced to the few paths a sort or group reads
 *     before the next chunk is read. Only the findings whose rows can change an answer are read: those
 *     that fail at most one built-in filter, since every facet and tile counts with one lifted.
 *  4. Filters, facets, tiles, by-rule rows, sorting and paging run in TypeScript over the slim
 *     findings (lib/view-pass.ts), using the engine's own functions.
 *  5. The page is then filled: the full text of its findings, and the first rows each shows. A row
 *     filter or a group on a returned column puts a condition on those rows, so the page's findings'
 *     rows are read once more, at most a page of findings.
 *
 * The export is the one reader that does want every row of every finding the view matches. It reads
 * them a batch of findings at a time, inside one read snapshot that stays open while the file is sent
 * (a connection of its own on SQLite, so a slow download never holds up a scan save or another read),
 * and never holds more than a batch (a finding with more rows than a block is read in blocks).
 *
 * Before the upgrade's copy into finding_rows has been proven, the old row columns are the truth (as
 * in listFindings()), so a view then reads every finding in full and the reference answers it.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { many, inReadTransaction, inSnapshotRead, type DbHandle } from './exec';
import {
  categories as categoriesTable, findingRows as findingRowsTable, findings as findingsTable,
  rules as rulesTable, suppressions as suppressionsTable,
} from './tables';
import { CHUNK_SIZE, chunk } from './chunk';
import { listReturnedColumnsIn } from './column-catalogue';
import { loadFindingRows, loadFindingRowsRange, rowToRecordFromColumns, rowToSummary, rowsTableReady, summaryColumns } from './findings';
import { ruleTagsOf } from '../rules';
import type { ExportSource, OpenExport } from '../export-stream';
import { pageBounds, type FindingRow } from '../finding-rows';
import { activeRowFilters, applyView, readPath, rowMatches, rowPath, valueText, type RowField, type RowFilter, type View, type ViewContext } from '../finding-view';
import { addEvidenceKeys, sortedKeys, type ExportPiece } from '../findings-export';
import { isActiveSuppression } from '../suppressions';
import {
  ColumnCounter, RowMatcher, answerExport, answerGroup, answerView, candidatesOf, columnPool, finishColumnValues, indexOf, rawGateOf, resolveContext, rowNeeds,
  type PageEntry, type ResolvedContext, type RowIndex, type SlimFinding,
} from '../view-pass';
import {
  ITEM_ROWS_PER_PAGE, TAB_KINDS, buildColumnValuesResponse, buildFindingRowsResponse, buildGroupResponse, buildViewResponse,
  decorateFinding, ruleDecoration, rulesInPlay,
  type ColumnValuesResponse, type ExplorerCategory, type FindingRowsResponse, type GroupResponse, type RuleDetails, type ViewItemResponse,
  type ViewResponse, type ViewTab,
} from '../view-response';

export interface ViewQuery {
  tab: ViewTab;
  /** Whether suppressed findings are listed. */
  showSuppressed: boolean;
}

// ---- Reads, on the transaction's handle ----

async function readRuleDetails(tx: DbHandle): Promise<Map<string, RuleDetails>> {
  const rows = await many(tx.select({
    id: rulesTable.id, name: rulesTable.name, enabled: rulesTable.enabled, tags: rulesTable.tags, group: rulesTable.group,
  }).from(rulesTable));
  return new Map(rows.map(r => [r.id, { name: r.name, enabled: r.enabled, tags: ruleTagsOf(r) }]));
}

async function readCategories(tx: DbHandle): Promise<ExplorerCategory[]> {
  const rows = await many(tx.select().from(categoriesTable).orderBy(asc(categoriesTable.sortOrder)));
  return rows.map(c => ({ id: c.id, label: c.label, color: c.color ?? undefined }));
}

async function readSuppressedFingerprints(tx: DbHandle): Promise<Set<string>> {
  const rows = await many(tx.select().from(suppressionsTable));
  return new Set(rows.filter(r => isActiveSuppression({ expiresAt: r.expiresAt ?? undefined })).map(r => r.fingerprint));
}

const fingerprintOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The tab's findings without rows, long text or evidence, in fingerprint order. */
async function readSlim(tx: DbHandle, tab: ViewTab, rules: ReadonlyMap<string, RuleDetails>): Promise<SlimFinding[]> {
  const t = findingsTable;
  const stored = await many(tx.select({
    fingerprint: t.fingerprint, ruleId: t.ruleId, category: t.category, severity: t.severity, kind: t.kind,
    dimensionKey: t.dimensionKey, resourceId: t.resourceId, resourceType: t.resourceType, resourceName: t.resourceName,
    subscriptionId: t.subscriptionId, resourceGroup: t.resourceGroup, location: t.location, title: t.title,
    status: t.status, firstSeenAt: t.firstSeenAt, lastSeenAt: t.lastSeenAt, resolvedAt: t.resolvedAt,
  }).from(t).where(inArray(t.kind, [...TAB_KINDS[tab]])));
  return stored
    .map((r): SlimFinding => ({
      fingerprint: r.fingerprint, ruleId: r.ruleId, category: r.category, severity: r.severity as SlimFinding['severity'],
      kind: r.kind as SlimFinding['kind'], dimensionKey: r.dimensionKey ?? undefined, resourceId: r.resourceId ?? undefined,
      resourceType: r.resourceType ?? undefined, resourceName: r.resourceName ?? undefined, subscriptionId: r.subscriptionId,
      resourceGroup: r.resourceGroup ?? undefined, location: r.location ?? undefined, title: r.title,
      status: r.status as SlimFinding['status'], firstSeenAt: r.firstSeenAt, lastSeenAt: r.lastSeenAt, resolvedAt: r.resolvedAt ?? undefined,
      ...ruleDecoration(r, rules.get(r.ruleId)),
    }))
    .sort((a, b) => fingerprintOrder(a.fingerprint, b.fingerprint));
}

/** How many rows each finding holds, counted from the rows table's key index. */
async function countAllRows(tx: DbHandle): Promise<Map<string, number>> {
  const counts = await many(tx.select({ fingerprint: findingRowsTable.fingerprint, n: sql<number>`count(*)` })
    .from(findingRowsTable).groupBy(findingRowsTable.fingerprint));
  return new Map(counts.map(c => [c.fingerprint, Number(c.n)]));
}

/** How many rows these findings hold, for those stored before their count was. */
async function countRowsOf(tx: DbHandle, fingerprints: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const fpChunk of chunk(fingerprints)) {
    const counts = await many(tx.select({ fingerprint: findingRowsTable.fingerprint, n: sql<number>`count(*)` })
      .from(findingRowsTable).where(inArray(findingRowsTable.fingerprint, fpChunk)).groupBy(findingRowsTable.fingerprint));
    for (const c of counts) out.set(c.fingerprint, Number(c.n));
  }
  return out;
}

/** Streams the stored rows of `fingerprints` to `onRow`, a chunk of findings at a time and each
 *  finding's rows in position order. A chunk's rows are parsed and handed on before the next chunk is
 *  read, so only one chunk of text is ever held. */
async function streamRows(
  tx: DbHandle, fingerprints: readonly string[], onRow: (fingerprint: string, row: FindingRow) => void,
  gate?: (text: string) => boolean,
): Promise<void> {
  for (const fpChunk of chunk(fingerprints)) {
    const stored = await many(tx.select().from(findingRowsTable).where(inArray(findingRowsTable.fingerprint, fpChunk))
      .orderBy(asc(findingRowsTable.fingerprint), asc(findingRowsTable.position)));
    const byFinding = new Map<string, string[]>();
    for (const r of stored) {
      const list = byFinding.get(r.fingerprint);
      if (list) list.push(r.data);
      else byFinding.set(r.fingerprint, [r.data]);
    }
    // In the order asked, whatever order the database sorted the text in.
    for (const fp of fpChunk) for (const data of byFinding.get(fp) ?? []) if (!gate || gate(data)) onRow(fp, JSON.parse(data) as FindingRow);
  }
}

// ---- What a view reads ----

interface Prepared {
  rules: Map<string, RuleDetails>;
  categories: ExplorerCategory[];
  ctx: ResolvedContext;
}

async function prepare(tx: DbHandle, view: View, query: ViewQuery): Promise<Prepared> {
  const ctx: ViewContext = {
    suppressedFingerprints: await readSuppressedFingerprints(tx),
    showSuppressed: query.showSuppressed,
  };
  return { rules: await readRuleDetails(tx), categories: await readCategories(tx), ctx: resolveContext(view, ctx) };
}

/** The row index a view's answer is built over: nothing, a count per finding, or the streamed rows. */
async function buildIndex(
  tx: DbHandle, slim: readonly SlimFinding[], view: View, ctx: ResolvedContext, groupPath?: readonly (string | null)[],
): Promise<RowIndex> {
  const needs = rowNeeds(view);
  if (!needs.any) return indexOf(view.groupBy.length > 0 ? await countAllRows(tx) : new Map());
  const candidates = candidatesOf(slim, view, ctx, groupPath);
  const matcher = new RowMatcher(needs.filters, needs.paths, fp => candidates.listed.has(fp));
  await streamRows(tx, candidates.fingerprints, (fp, row) => matcher.add(fp, row), rawGateOf(needs.filters));
  return indexOf(matcher.counts, matcher.rows);
}

// ---- The page ----

/** Turns a page of entries into items: each finding's full text, and its first rows. Rows come from
 *  one read of the first 20 of each finding unless the view or the group puts a condition on them, in
 *  which case all of the page's findings' rows are read and the condition is applied here. */
async function fillEntries(
  tx: DbHandle, entries: readonly PageEntry[], view: View, rules: ReadonlyMap<string, RuleDetails>,
): Promise<ViewItemResponse[]> {
  if (entries.length === 0) return [];
  const fingerprints = [...new Set(entries.map(e => e.finding.fingerprint))];
  const stored = new Map<string, Awaited<ReturnType<typeof readSummaries>>[number]>();
  for (const row of await readSummaries(tx, fingerprints)) stored.set(row.fingerprint, row);

  const rowFilters = activeRowFilters(view.filters);
  const conditional = (e: PageEntry) => rowFilters.length > 0 || e.conditions.length > 0;
  const plain = fingerprints.filter(fp => !entries.some(e => e.finding.fingerprint === fp && conditional(e)));
  const first = await loadFindingRows(tx, plain, ITEM_ROWS_PER_PAGE);
  const all = await loadFindingRows(tx, fingerprints.filter(fp => !plain.includes(fp)));
  const unknownCount = plain.filter(fp => stored.get(fp)!.rowCount === null);
  const counted = await countRowsOf(tx, unknownCount);

  return entries.map((entry): ViewItemResponse => {
    const row = stored.get(entry.finding.fingerprint)!;
    const finding = { ...rowToSummary(row), ...ruleDecoration(row, rules.get(row.ruleId)) };
    if (!conditional(entry)) {
      const rowCount = row.rowCount ?? counted.get(row.fingerprint) ?? 0;
      return { finding, rows: first.get(row.fingerprint) ?? [], rowCount, matchedRowCount: rowCount };
    }
    const rows = all.get(row.fingerprint) ?? [];
    const matched = rows.filter(r => rowFilters.every(f => f.values.includes(valueText(readPath(r, rowPath(f.field)))))
      && entry.conditions.every(c => (valueText(readPath(r, c.path)) || null) === c.value));
    return { finding, rows: matched.slice(0, ITEM_ROWS_PER_PAGE), rowCount: rows.length, matchedRowCount: matched.length };
  });
}

async function readSummaries(tx: DbHandle, fingerprints: readonly string[]) {
  const out: Awaited<ReturnType<typeof readSummaryChunk>> = [];
  for (const fpChunk of chunk(fingerprints)) out.push(...await readSummaryChunk(tx, fpChunk));
  return out;
}
function readSummaryChunk(tx: DbHandle, fingerprints: string[]) {
  return many(tx.select(summaryColumns).from(findingsTable).where(inArray(findingsTable.fingerprint, fingerprints)));
}

// ---- Before the upgrade's copy has been proven ----

/** Every finding of the tab in full, from the old row columns, as the explorer holds them. */
async function readWhole(tx: DbHandle, tab: ViewTab, rules: ReadonlyMap<string, RuleDetails>) {
  const stored = await many(tx.select().from(findingsTable).where(inArray(findingsTable.kind, [...TAB_KINDS[tab]])));
  return stored
    .map(row => decorateFinding(rowToRecordFromColumns(row), rules.get(row.ruleId)))
    .sort((a, b) => fingerprintOrder(a.fingerprint, b.fingerprint));
}

// ---- The answers ----

/** The first response for a view: the page of findings or groups, tiles, facets, by-rule rows and
 *  the column list, all from one read. */
export function queryView(view: View, query: ViewQuery): Promise<ViewResponse> {
  return inReadTransaction(async (tx) => {
    const { rules, categories, ctx } = await prepare(tx, view, query);
    if (!(await rowsTableReady(tx))) {
      const findings = await readWhole(tx, query.tab, rules);
      const catalogueColumns = await listReturnedColumnsIn(tx, rulesInPlay(findings));
      return buildViewResponse(findings, view, ctx, { tab: query.tab, catalogueColumns, categories });
    }
    const slim = await readSlim(tx, query.tab, rules);
    const index = await buildIndex(tx, slim, view, ctx);
    const catalogueColumns = await listReturnedColumnsIn(tx, rulesInPlay(slim));
    const { entries, ...answer } = answerView(slim, index, view, ctx, { tab: query.tab, catalogueColumns, categories });
    return { ...answer, items: await fillEntries(tx, entries, view, rules) };
  });
}

/** One finding's rows that match the view's row filters, a page of them, or null when the tab lists
 *  no finding with that fingerprint. Reads only that finding. */
export function queryFindingRows(view: View, query: ViewQuery & { fingerprint: string; rowsPage: number }): Promise<FindingRowsResponse | null> {
  return inReadTransaction(async (tx) => {
    const where = and(eq(findingsTable.fingerprint, query.fingerprint), inArray(findingsTable.kind, [...TAB_KINDS[query.tab]]));
    const rules = await readRuleDetails(tx);
    const ready = await rowsTableReady(tx);
    const [row] = ready
      ? await many(tx.select(summaryColumns).from(findingsTable).where(where))
      : await many(tx.select().from(findingsTable).where(where));
    if (!row) return null;
    // Nothing to match a row against: the page is a slice of the stored rows, so read that slice.
    if (ready && activeRowFilters(view.filters).length === 0) return readRowsPage(tx, row, query);
    const record = ready
      ? await withRows(tx, row)
      : rowToRecordFromColumns(row as typeof findingsTable.$inferSelect);
    const finding = decorateFinding(record, rules.get(row.ruleId));
    return buildFindingRowsResponse([finding], view, {}, { tab: query.tab, fingerprint: query.fingerprint, rowsPage: query.rowsPage });
  });
}

/** What `buildFindingRowsResponse` answers for a finding no row filter narrows, from the stored row
 *  count and the one page of rows asked for. */
async function readRowsPage(
  tx: DbHandle, row: Pick<typeof findingsTable.$inferSelect, 'fingerprint' | 'rowCount'>, query: { rowsPage: number },
): Promise<FindingRowsResponse> {
  const total = row.rowCount ?? (await countRowsOf(tx, [row.fingerprint])).get(row.fingerprint) ?? 0;
  const bounds = pageBounds(total, query.rowsPage, ITEM_ROWS_PER_PAGE);
  const rows = await loadFindingRowsRange(tx, row.fingerprint, bounds.firstIndex, ITEM_ROWS_PER_PAGE);
  return { fingerprint: row.fingerprint, rows, ...bounds, matchedRowCount: total, rowCount: total };
}

async function withRows(tx: DbHandle, row: Parameters<typeof rowToSummary>[0]) {
  const rows = (await loadFindingRows(tx, [row.fingerprint])).get(row.fingerprint) ?? [];
  return { ...rowToSummary(row), evidence: rows[0] ?? {}, rows };
}

/** One group's contents: the next level's groups, or the findings of the last level, a page of them. */
export function queryGroup(view: View, query: ViewQuery & { groupPath: readonly (string | null)[]; groupPage: number }): Promise<GroupResponse> {
  return inReadTransaction(async (tx) => {
    const { rules, categories, ctx } = await prepare(tx, view, query);
    const options = { tab: query.tab, catalogueColumns: [], categories, groupPath: query.groupPath, groupPage: query.groupPage };
    if (!(await rowsTableReady(tx))) return buildGroupResponse(await readWhole(tx, query.tab, rules), view, ctx, options);

    const slim = await readSlim(tx, query.tab, rules);
    // A path that leads nowhere reads nothing: it has no group to narrow the findings to.
    const valid = query.groupPath.length > 0 && query.groupPath.length <= view.groupBy.length;
    const index = await buildIndex(tx, slim, view, ctx, valid ? query.groupPath : undefined);
    const { entries, ...answer } = answerGroup(slim, index, view, ctx, options);
    return { ...answer, items: await fillEntries(tx, entries, view, rules) };
  });
}

export interface FilterOptions {
  subscriptions: string[];
  resourceGroups: string[];
  rules: { id: string; name: string }[];
}

/** What the dashboard's filter lists offer: every subscription, resource group and rule that has a
 *  finding on either tab, whatever its status. A view's facets cannot answer this, since they count
 *  one tab's findings under that view's filters and window. Reads no rows. */
export function queryFilterOptions(): Promise<FilterOptions> {
  return inReadTransaction(async (tx) => {
    const rules = await readRuleDetails(tx);
    const found = [...await readSlim(tx, 'results', rules), ...await readSlim(tx, 'advisories', rules)];
    const named = new Map(found.map(f => [f.ruleId, { id: f.ruleId, name: rules.get(f.ruleId)?.name ?? f.title }]));
    return {
      subscriptions: [...new Set(found.map(f => f.subscriptionId).filter(Boolean))].sort(),
      resourceGroups: [...new Set(found.map(f => f.resourceGroup).filter((g): g is string => Boolean(g)))].sort(),
      rules: [...named.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

/** The values one returned column holds, for its filter's option list. */
export function queryColumnValues(view: View, query: ViewQuery & { column: RowField; q?: string }): Promise<ColumnValuesResponse> {
  return inReadTransaction(async (tx) => {
    const { rules, ctx } = await prepare(tx, view, query);
    if (!(await rowsTableReady(tx))) {
      return buildColumnValuesResponse(await readWhole(tx, query.tab, rules), view, ctx, { tab: query.tab, column: query.column, q: query.q });
    }
    const slim = await readSlim(tx, query.tab, rules);
    const path = rowPath(query.column);
    const others = activeRowFilters(view.filters, new Set([query.column]));
    const counter = new ColumnCounter(others, path);
    await streamRows(tx, columnPool(slim, view, ctx).map(f => f.fingerprint), (fp, row) => counter.add(fp, row), rawGateOf(others));
    return finishColumnValues(counter.result(), query.column, query.q);
  });
}

// ---- The export ----

/** A finding with more rows than this is read a block of rows at a time, so no read holds more than a
 *  block of one finding's rows. */
export const EXPORT_ROW_BLOCK = 500;
/** The most findings, and the most rows, one read of smaller findings holds. */
export const EXPORT_BATCH_FINDINGS = CHUNK_SIZE;
export const EXPORT_BATCH_ROWS = 4 * EXPORT_ROW_BLOCK;

/** Some of one finding's matched rows: all of them, or a block of a larger finding's. */
interface RowBlock { fingerprint: string; rows: FindingRow[]; start: boolean; end: boolean }

/** A read of findings that are small enough to read together, or one that is not. */
type ExportRead = { fingerprints: string[] } | { block: string };

/** Splits the findings, in order, into reads that stay under the limits above. */
export function planExportReads(fingerprints: readonly string[], counts: ReadonlyMap<string, number>): ExportRead[] {
  const reads: ExportRead[] = [];
  let run: string[] = [];
  let runRows = 0;
  const close = () => {
    if (run.length > 0) reads.push({ fingerprints: run });
    run = [];
    runRows = 0;
  };
  for (const fingerprint of fingerprints) {
    const rows = counts.get(fingerprint) ?? 0;
    if (rows > EXPORT_ROW_BLOCK) {
      close();
      reads.push({ block: fingerprint });
      continue;
    }
    if (run.length >= EXPORT_BATCH_FINDINGS || runRows + rows > EXPORT_BATCH_ROWS) close();
    run.push(fingerprint);
    runRows += rows;
  }
  close();
  return reads;
}

/** Each read's rows that pass the view's row filters, a read at a time. */
async function* readExportRows(tx: DbHandle, reads: readonly ExportRead[], rowFilters: readonly RowFilter[]): AsyncGenerator<RowBlock[]> {
  const passing = (rows: FindingRow[]) => (rowFilters.length === 0 ? rows : rows.filter(row => rowFilters.every(f => rowMatches(row, f))));
  for (const read of reads) {
    if (!('block' in read)) {
      const loaded = await loadFindingRows(tx, read.fingerprints);
      yield read.fingerprints.map(fingerprint => ({ fingerprint, rows: passing(loaded.get(fingerprint) ?? []), start: true, end: true }));
      continue;
    }
    // The next block is read before this one is handed on, which is how its last block is known.
    let block = await loadFindingRowsRange(tx, read.block, 0, EXPORT_ROW_BLOCK);
    for (let from = 0, start = true; ; from += EXPORT_ROW_BLOCK, start = false) {
      const next = block.length === EXPORT_ROW_BLOCK ? await loadFindingRowsRange(tx, read.block, from + EXPORT_ROW_BLOCK, EXPORT_ROW_BLOCK) : [];
      yield [{ fingerprint: read.block, rows: passing(block), start, end: next.length === 0 }];
      if (next.length === 0) break;
      block = next;
    }
  }
}

/** Every matched row of the findings, as pieces with their finding's own fields beside them. */
async function* exportPieces(
  tx: DbHandle, reads: readonly ExportRead[], rowFilters: readonly RowFilter[], rules: ReadonlyMap<string, RuleDetails>,
): AsyncGenerator<ExportPiece[]> {
  for await (const blocks of readExportRows(tx, reads, rowFilters)) {
    const stored = new Map((await readSummaries(tx, [...new Set(blocks.map(b => b.fingerprint))])).map(r => [r.fingerprint, r]));
    yield blocks.map(({ fingerprint, rows, start, end }) => {
      const row = stored.get(fingerprint)!;
      return { finding: { ...rowToSummary(row), ...ruleDecoration(row, rules.get(row.ruleId)) }, rows, start, end };
    });
  }
}

/** What an export of the view reads: the findings the view lists in its order, ungrouped, with every
 *  row that passes its row filters. */
async function exportSource(tx: DbHandle, view: View, query: ViewQuery): Promise<ExportSource> {
  const flat: View = { ...view, groupBy: [] };
  const { rules, ctx } = await prepare(tx, flat, query);
  const rowFilters = activeRowFilters(flat.filters);

  if (!(await rowsTableReady(tx))) {
    const pieces = applyView(await readWhole(tx, query.tab, rules), flat, ctx).matched.map(({ finding, rows }): ExportPiece => {
      const { rows: _rows, ...own } = finding;
      return { finding: own, rows, start: true, end: true };
    });
    return {
      async columns() {
        const keys = new Set<string>();
        for (const piece of pieces) for (const row of piece.rows) addEvidenceKeys(keys, row);
        return { evidenceKeys: sortedKeys(keys), lifecycle: pieces.length > 0 };
      },
      async *batches() { yield* chunk(pieces, EXPORT_BATCH_FINDINGS); },
    };
  }

  const slim = await readSlim(tx, query.tab, rules);
  // An empty path asks for the listed findings alone: the facets and tiles of a view are not wanted.
  const index = await buildIndex(tx, slim, flat, ctx, []);
  const fingerprints = answerExport(slim, index, flat, ctx).map(f => f.fingerprint);
  const reads = planExportReads(fingerprints, await countRowsOf(tx, fingerprints));
  return {
    async columns() {
      const keys = new Set<string>();
      for await (const blocks of readExportRows(tx, reads, rowFilters)) for (const block of blocks) for (const row of block.rows) addEvidenceKeys(keys, row);
      return { evidenceKeys: sortedKeys(keys), lifecycle: fingerprints.length > 0 };
    },
    batches: () => exportPieces(tx, reads, rowFilters, rules),
  };
}

/** The export of a view, to be read inside a snapshot that stays open as long as `use` runs
 *  (lib/export-stream.ts keeps it open for as long as the download reads). */
export function openExport(view: View, query: ViewQuery): OpenExport {
  return use => inSnapshotRead(async tx => use(await exportSource(tx, view, query)));
}
