/**
 * The server's own way of answering a view (ADR 0007), as pure functions. lib/view-response.ts is the
 * reference: it is handed every finding with every row. This is handed what a database read can
 * afford to hold, and answers the same thing:
 *
 *  - the findings of the tab without their rows or long text (`SlimFinding`);
 *  - a `RowIndex`, which says for each finding how many of its rows match the view's row filters and
 *    keeps those rows reduced to the few paths a sort or a group reads. It is built by streaming the
 *    stored rows past a `RowMatcher`, one row at a time, so no row is held after it has been tested.
 *
 * Built-in filters, search, window, suppression, facets, tiles and the by-rule rows are the engine's
 * own functions over the slim findings. What is left for a second read is the page: the full text of
 * the findings on it and the first rows each shows (lib/db/finding-views.ts).
 *
 * Ties are broken on the fingerprint: the findings arrive in fingerprint order and every sort is
 * stable. The reference is fed in that order by the parity test.
 */
import { resolveDateWindow } from './date-window';
import type { ExplorerFinding } from './explorer-data';
import type { FindingRow } from './finding-rows';
import { countFindingsByRule, summarizeFindings } from './explorer-filters';
import {
  BUILTIN_FIELDS, DEFAULT_PAGE_SIZE, DEFAULT_SORT, activeRowFilters, builtinFieldValues, clampPage, compareBy, compareGroups, filterFindings,
  groupParts, isRowField, isRowFilter, pageGroupItems, readPath, rowMatches, rowPath, valueText,
  type RowFilter, type View, type ViewContext, type ViewField,
} from './finding-view';
import {
  COLUMN_VALUES_LIMIT, GROUP_ITEMS_PER_PAGE, TAB_KINDS, TILE_EXCLUDED_FIELDS, buildFacets, buildRuleRows, columnsOf, groupHeader,
  lastScanAtOf, policyOptionsOf, suppressedCountOf, tileKinds, valueLabeler,
  type ColumnValuesResponse, type GroupHeader, type GroupResponse, type ViewResponse, type ViewResponseOptions,
} from './view-response';

/** A finding as a pass holds it: what filters, facets, tiles and sorts read, and nothing else. */
export type SlimFinding = Pick<ExplorerFinding,
  'fingerprint' | 'ruleId' | 'category' | 'severity' | 'kind' | 'dimensionKey' | 'resourceId' | 'resourceType' | 'resourceName'
  | 'subscriptionId' | 'resourceGroup' | 'location' | 'title' | 'status' | 'firstSeenAt' | 'lastSeenAt' | 'resolvedAt'
  | 'policyName' | 'ruleDisabled' | 'ruleTags'>;

/** A view's context with its window resolved to dates, once, so every part agrees on them. */
export type ResolvedContext = ViewContext & { range: { from: string; to: string } };

export function resolveContext(view: View, ctx: ViewContext): ResolvedContext {
  return { ...ctx, range: ctx.range ?? resolveDateWindow(view.window) };
}

/** The view with its row filters left out: what the built-in side of every pool is computed from. */
const builtinOnly = (view: View): View => ({ ...view, filters: view.filters.filter(f => !isRowFilter(f)) });

// ---- What a view needs of the rows ----

export interface RowNeeds {
  /** The row filters that constrain anything. */
  filters: RowFilter[];
  /** The paths a sort or a group reads, which a matched row is reduced to. */
  paths: string[];
  /** Whether the answer reads any row value, so the rows have to be streamed. */
  any: boolean;
}

export function rowNeeds(view: View): RowNeeds {
  const filters = activeRowFilters(view.filters);
  const paths = new Set<string>();
  for (let sort: View['sort'] | undefined = view.sort ?? DEFAULT_SORT; sort; sort = sort.then) {
    if (isRowField(sort.field)) paths.add(rowPath(sort.field));
  }
  for (const field of view.groupBy) if (isRowField(field)) paths.add(rowPath(field));
  return { filters, paths: [...paths], any: filters.length > 0 || paths.size > 0 };
}

/** A row with only the values at `paths`, each under its full path, which `readPath` reads back the
 *  way it read them from the whole row. A path the row leads nowhere on is left out. */
export function compactRow(row: FindingRow, paths: readonly string[]): FindingRow {
  const entries: [string, unknown][] = [];
  for (const path of paths) {
    const value = readPath(row, path);
    if (value !== undefined) entries.push([path, value]);
  }
  return Object.fromEntries(entries);
}

/** A value the stored text of a row must contain for the row to hold it: letters, digits and a few
 *  plain marks, at least one letter, and nothing a number or a bit of JSON could be written as. A
 *  string cell of exactly this text has it in the row's JSON unchanged, however that was written. */
const PLAIN_VALUE = /^(?=.*[A-Za-z])[A-Za-z0-9 _.-]+$/;
const isPlainValue = (value: string) => PLAIN_VALUE.test(value) && Number.isNaN(Number(value));

/**
 * A cheap test of a row's stored text, run before the row is parsed: false means the row cannot pass
 * the filters, so it is not parsed. It never says false for a row that passes. A filter is tested only
 * when every one of its values is plain; a filter with any other value (a number, an object's text, an
 * empty value) is left to the parse.
 */
export function rawGateOf(filters: readonly RowFilter[]): ((text: string) => boolean) | undefined {
  const needles = filters.filter(f => f.values.length > 0 && f.values.every(isPlainValue)).map(f => f.values);
  if (needles.length === 0) return undefined;
  return text => needles.every(values => values.some(value => text.includes(value)));
}

/** Tests rows as they stream past: how many of each finding's rows pass every row filter, and, for
 *  the findings `keep` names, those rows reduced to `paths`. Holds no row it has finished with. */
export class RowMatcher {
  readonly counts = new Map<string, number>();
  readonly rows = new Map<string, FindingRow[]>();

  constructor(
    private readonly filters: readonly RowFilter[],
    private readonly paths: readonly string[],
    private readonly keep: (fingerprint: string) => boolean,
  ) {}

  add(fingerprint: string, row: FindingRow): void {
    for (const filter of this.filters) if (!rowMatches(row, filter)) return;
    this.counts.set(fingerprint, (this.counts.get(fingerprint) ?? 0) + 1);
    if (this.paths.length === 0 || !this.keep(fingerprint)) return;
    const kept = this.rows.get(fingerprint);
    if (kept) kept.push(compactRow(row, this.paths));
    else this.rows.set(fingerprint, [compactRow(row, this.paths)]);
  }
}

/** Says, per finding, how many rows match the view's row filters and what the sorts and groups read
 *  of them. A view that reads no row value has no rows to give. */
export interface RowIndex {
  count(finding: { fingerprint: string }): number;
  rows(finding: { fingerprint: string }): FindingRow[];
}

export function indexOf(counts: ReadonlyMap<string, number>, rows?: ReadonlyMap<string, FindingRow[]>): RowIndex {
  return { count: f => counts.get(f.fingerprint) ?? 0, rows: f => rows?.get(f.fingerprint) ?? [] };
}

/** Whether a finding falls in the group a path names, as far as its built-in levels say. A row level
 *  is decided by the finding's rows, so it never rules a finding out here. */
function fitsBuiltinLevels(f: SlimFinding, groupBy: readonly ViewField[], path: readonly (string | null)[]): boolean {
  return path.every((value, i) => {
    const field = groupBy[i]!;
    if (isRowField(field)) return true;
    const values = [...new Set(builtinFieldValues(f, field))].filter(v => v !== '');
    return value === null ? values.length === 0 : values.includes(value);
  });
}

export interface Candidates {
  /** The findings whose rows can change an answer, in fingerprint order. */
  fingerprints: string[];
  /** The ones the view lists: those that pass its built-in filters. */
  listed: Set<string>;
}

/**
 * The findings whose rows have to be read. A row filter decides whether a finding is in a pool, and
 * every facet, tile and by-rule count has a pool of its own (every filter but one lifted), so those
 * pools are the candidates: a finding that fails two built-in filters is in none of them. Without a
 * row filter only the findings the view lists matter, for their sort or group. `groupPath` narrows to
 * the findings an opened group can hold.
 */
export function candidatesOf(
  slim: readonly SlimFinding[], view: View, ctx: ResolvedContext, groupPath?: readonly (string | null)[],
): Candidates {
  const spec = builtinOnly(view);
  const fits = (f: SlimFinding) => !groupPath || fitsBuiltinLevels(f, view.groupBy, groupPath);
  const listed = new Set(filterFindings(slim, spec, ctx).filter(fits).map(f => f.fingerprint));
  const wanted = new Set(listed);
  if (!groupPath && activeRowFilters(view.filters).length > 0) {
    const add = (except: readonly ViewField[]) => {
      for (const f of filterFindings(slim, spec, ctx, { except: new Set(except) })) wanted.add(f.fingerprint);
    };
    for (const field of BUILTIN_FIELDS) if (field !== 'status') add([field]);
    add(TILE_EXCLUDED_FIELDS);
    add(['status']);
  }
  return { fingerprints: slim.filter(f => wanted.has(f.fingerprint)).map(f => f.fingerprint), listed };
}

// ---- Groups, counted ----

/** A finding in a group, with the rows that fell in it (reduced to the paths read) and how many. */
interface Member { finding: SlimFinding; rows: FindingRow[]; count: number }
interface Bucket { field: ViewField; value: string | null; members: Member[]; resourceCount: number; rowCount: number }

function bucketMembers(members: readonly Member[], field: ViewField): Bucket[] {
  const buckets = new Map<string | null, Member[]>();
  for (const m of members) {
    for (const part of groupParts({ finding: m.finding, rows: m.rows }, field)) {
      const member = { finding: m.finding, rows: part.rows, count: isRowField(field) ? part.rows.length : m.count };
      const bucket = buckets.get(part.value);
      if (bucket) bucket.push(member);
      else buckets.set(part.value, [member]);
    }
  }
  return [...buckets].map(([value, list]) => ({
    field, value, members: list, resourceCount: list.length, rowCount: list.reduce((n, m) => n + m.count, 0),
  }));
}

const orderBuckets = (buckets: Bucket[], sort: View['groupSort'], label: (field: ViewField, value: string) => string): Bucket[] =>
  buckets.sort((a, b) => compareGroups(a, b, sort, label));

// ---- The answers ----

/** A finding on a page, and the conditions on its rows the group it was listed in puts: the page's
 *  rows are those that pass the view's row filters and every condition. */
export interface RowCondition { path: string; value: string | null }
export interface PageEntry { finding: SlimFinding; conditions: RowCondition[] }

export type ViewAnswer = Omit<ViewResponse, 'items'> & { entries: PageEntry[] };
export type GroupAnswer = Omit<GroupResponse, 'items'> & { entries: PageEntry[] };

/** The first response for a view, from the slim findings and the row index. `entries` is the page of
 *  findings, which the caller turns into items by reading each one's text and rows. */
export function answerView(
  slim: readonly SlimFinding[], index: RowIndex, view: View, ctx: ResolvedContext, opts: ViewResponseOptions,
): ViewAnswer {
  const { from, to } = ctx.range;
  const spec = builtinOnly(view);
  const rowFilters = activeRowFilters(view.filters);
  const label = valueLabeler(slim, opts.categories);

  const pools = new Map<string, SlimFinding[]>();
  const pool = (except: ViewField[] = []): SlimFinding[] => {
    const key = [...except].sort().join('|');
    let found = pools.get(key);
    if (!found) {
      const builtin = filterFindings(slim, spec, ctx, { except: new Set(except) });
      found = rowFilters.length > 0 ? builtin.filter(f => index.count(f) > 0) : builtin;
      pools.set(key, found);
    }
    return found;
  };

  const sort = view.sort ?? DEFAULT_SORT;
  const listed = pool();
  const matched = listed.map(finding => ({ finding, rows: index.rows(finding) })).sort((a, b) => compareBy(a, b, sort));
  const flat = clampPage(matched.length, view.page, view.pageSize);

  let grouped: ViewResponse['grouped'] = null;
  if (view.groupBy.length > 0) {
    const top = orderBuckets(
      bucketMembers(matched.map(m => ({ finding: m.finding, rows: m.rows, count: index.count(m.finding) })), view.groupBy[0]!),
      view.groupSort, label,
    );
    const page = clampPage(top.length, view.page, view.pageSize);
    grouped = {
      groups: top.slice((page.page - 1) * page.pageSize, page.page * page.pageSize).map(b => groupHeader(b, label)),
      groupTotal: top.length,
      rowTotal: matched.reduce((n, m) => n + index.count(m.finding), 0),
      page: page.page,
      pageCount: page.pageCount,
    };
  }

  return {
    tab: opts.tab,
    kinds: TAB_KINDS[opts.tab],
    total: matched.length,
    page: grouped?.page ?? flat.page,
    pageCount: grouped?.pageCount ?? flat.pageCount,
    pageSize: Math.max(1, Math.floor(view.pageSize) || DEFAULT_PAGE_SIZE),
    entries: grouped ? [] : matched.slice((flat.page - 1) * flat.pageSize, flat.page * flat.pageSize).map(m => ({ finding: m.finding, conditions: [] })),
    grouped,
    tiles: summarizeFindings(pool([...TILE_EXCLUDED_FIELDS]), from, to, tileKinds(opts.tab)),
    facets: buildFacets(pool, label),
    ruleRows: buildRuleRows(matched.map(m => m.finding), countFindingsByRule(pool(['status']), from, to, tileKinds(opts.tab))),
    columns: columnsOf(opts.catalogueColumns, view),
    suppressedCount: suppressedCountOf(slim, view, ctx),
    lastScanAt: lastScanAtOf(slim),
    policyOptions: policyOptionsOf(slim),
    categories: opts.categories,
  };
}

/** One group's contents, walked down `groupPath` one level at a time. Only that group's findings are
 *  bucketed again for the next level, and only the last level is sorted and paged. */
export function answerGroup(
  slim: readonly SlimFinding[], index: RowIndex, view: View, ctx: ResolvedContext,
  opts: Pick<ViewResponseOptions, 'categories'> & { groupPath: readonly (string | null)[]; groupPage: number },
): GroupAnswer {
  const spec = builtinOnly(view);
  const label = valueLabeler(slim, opts.categories);
  const none: GroupAnswer = { group: null, groups: [], entries: [], total: 0, page: 1, pageCount: 1 };
  if (opts.groupPath.length === 0 || opts.groupPath.length > view.groupBy.length) return none;

  const rowFilters = activeRowFilters(view.filters);
  let members: Member[] = filterFindings(slim, spec, ctx)
    .filter(f => rowFilters.length === 0 || index.count(f) > 0)
    .map(finding => ({ finding, rows: index.rows(finding), count: index.count(finding) }));
  const conditions: RowCondition[] = [];
  let bucket: Bucket | undefined;
  for (const [i, value] of opts.groupPath.entries()) {
    const field = view.groupBy[i]!;
    bucket = bucketMembers(members, field).find(b => b.value === value);
    if (!bucket) return none;
    if (isRowField(field)) conditions.push({ path: rowPath(field), value });
    members = bucket.members;
  }

  const last = opts.groupPath.length === view.groupBy.length;
  const sort = view.sort ?? DEFAULT_SORT;
  const nextLevel: GroupHeader[] = last ? [] : orderBuckets(bucketMembers(members, view.groupBy[opts.groupPath.length]!), view.groupSort, label)
    .map(b => groupHeader(b, label));
  const page = pageGroupItems(last ? [...members].sort((a, b) => compareBy(a, b, sort)) : [], opts.groupPage, GROUP_ITEMS_PER_PAGE);
  return {
    group: groupHeader(bucket!, label),
    groups: nextLevel,
    entries: page.items.map(m => ({ finding: m.finding, conditions })),
    total: page.total, page: page.page, pageCount: page.pageCount,
  };
}

/** Counts, for a returned column's option list, how many findings hold each value: a finding once per
 *  distinct non-empty value, over the rows that pass the other row filters. Rows stream past it
 *  grouped by finding. */
export class ColumnCounter {
  private readonly counts = new Map<string, number>();
  private readonly own = new Set<string>();
  private current: string | null = null;

  constructor(private readonly others: readonly RowFilter[], private readonly path: string) {}

  add(fingerprint: string, row: FindingRow): void {
    if (fingerprint !== this.current) { this.flush(); this.current = fingerprint; }
    for (const filter of this.others) if (!rowMatches(row, filter)) return;
    const text = valueText(readPath(row, this.path));
    if (text !== '') this.own.add(text);
  }

  private flush(): void {
    for (const text of this.own) this.counts.set(text, (this.counts.get(text) ?? 0) + 1);
    this.own.clear();
  }

  result(): Map<string, number> {
    this.flush();
    return this.counts;
  }
}

/** The option list from the counts: those that contain `q` ignoring case, most findings first, the
 *  top 100, with how many matched before the cut. Ordered as the reference orders them, which is by
 *  value first so that values `localeCompare` calls equal keep a stable order. */
export function finishColumnValues(counts: ReadonlyMap<string, number>, column: ColumnValuesResponse['column'], q?: string): ColumnValuesResponse {
  const needle = (q ?? '').toLowerCase();
  const matching = [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => a.value.localeCompare(b.value))
    .filter(o => needle === '' || o.value.toLowerCase().includes(needle))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  return { column, values: matching.slice(0, COLUMN_VALUES_LIMIT), total: matching.length };
}

/** The findings a column's values are counted over: those that pass every filter but the row filters. */
export function columnPool(slim: readonly SlimFinding[], view: View, ctx: ResolvedContext): SlimFinding[] {
  return filterFindings(slim, builtinOnly(view), ctx);
}
