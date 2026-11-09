/**
 * The view engine (ADR 0006): one pure function that takes findings with their rows and a View and
 * returns the page to show. The Results tab, the Advisories tab and the Advisories widget all read
 * through it, and so does the URL: `viewToSearchParams` and `viewFromSearchParams` are the only
 * place a View is turned into query params and back, so the server page and the explorer cannot
 * drift. Client-safe: no Node, no database, no framework imports.
 *
 * A field is a built-in finding field or a column the rule's query returned, named `row.<path>`
 * with a dot path into a row. A filter on a built-in field keeps or drops the whole finding. A
 * filter on a returned column keeps only the rows that match, and drops a finding with none.
 */
import type { Severity } from './types';
import { resolveDateWindow, type DateWindow } from './date-window';
import { findingRows, type FindingRow } from './finding-rows';
import { subscriptionValue } from './placement';
import { parseCategoryParam } from './scans-link';
import { SEVERITY_ORDER } from './severity';
import {
  EXPLORER_SEVERITIES, matchesExplorerFilters, parseExplorerStatus,
  type ExplorerFilterDim, type ExplorerFilterState, type FilterableFinding,
} from './explorer-filters';

// ---- Types ----

export const BUILTIN_FIELDS = [
  'rule', 'kind', 'category', 'severity', 'status', 'subscription', 'resourceGroup', 'location',
  'resourceType', 'resourceName', 'tags', 'firstSeen', 'lastSeen',
] as const;
export type BuiltinField = (typeof BUILTIN_FIELDS)[number];
export type RowField = `row.${string}`;
export type ViewField = BuiltinField | RowField;

/** A set of accepted values on a built-in field. Empty accepts everything. `rule` holds rule ids,
 *  `status` one of open/new/fixed/all, `resourceName` the subject the Resource column shows (see
 *  `findingSubject`), `firstSeen` and `lastSeen` day keys (YYYY-MM-DD). */
export interface BuiltinFilter { field: BuiltinField; values: string[] }
/** A filter on a returned column: a set of accepted values, compared as text. An empty set
 *  accepts everything. */
export interface RowFilter { field: RowField; values: string[] }
export type ViewFilter = BuiltinFilter | RowFilter;

/** `then` breaks ties on the one before it. The URL carries only the first. */
export interface ViewSort { field: ViewField; dir: 'asc' | 'desc'; then?: ViewSort }

/** How groups are ordered at every level: by their value (Name), or by how many findings they hold (Findings). */
export interface GroupSort { by: 'value' | 'count'; dir: 'asc' | 'desc' }

export interface View {
  filters: ViewFilter[];
  /** Free text over resource name, rule name, type and resource id. */
  search: string;
  /** What "new" and "fixed" mean for the status filter. */
  window: DateWindow;
  /** Returned-column paths to show after the built-in columns, in display order. */
  columns: string[];
  /** Null reads as DEFAULT_SORT. */
  sort: ViewSort | null;
  /** Fields to group by, outermost first. Empty is the flat list. */
  groupBy: ViewField[];
  groupSort: GroupSort;
  /** 1-based. */
  page: number;
  pageSize: number;
}

/** The part of a View that decides which findings (and rows) match. */
export type ViewFilterSpec = Pick<View, 'filters' | 'search' | 'window'>;

/** What a View cannot know: which findings are suppressed, and the window as concrete dates (the
 *  explorer resolves it once so the tiles and the table agree). */
export interface ViewContext {
  suppressedFingerprints?: ReadonlySet<string>;
  showSuppressed?: boolean;
  range?: { from: string; to: string };
}

export type ViewFinding = FilterableFinding & {
  lastSeenAt: string;
  /** What an activity finding is about, in place of a resource. */
  dimensionKey?: string;
  rows?: FindingRow[] | null;
  evidence?: FindingRow | null;
};

export interface ViewItem<T> { finding: T; rows: FindingRow[] }

export interface ViewPage<T> {
  /** The requested page of findings, each with the rows to show for it. */
  items: ViewItem<T>[];
  /** Findings that match, across every page. */
  total: number;
  /** The page returned, 1-based and clamped into range. */
  page: number;
  pageCount: number;
  /** Every match, sorted, before paging: what an export holds. */
  matched: ViewItem<T>[];
}

export const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_WINDOW_DAYS = 7;
export const DEFAULT_SORT: ViewSort = { field: 'severity', dir: 'asc' };
export const DEFAULT_GROUP_SORT: GroupSort = { by: 'value', dir: 'asc' };

export function emptyView(): View {
  return {
    filters: [], search: '', window: { mode: 'relative', days: DEFAULT_WINDOW_DAYS },
    columns: [], sort: null, groupBy: [], groupSort: { ...DEFAULT_GROUP_SORT }, page: 1, pageSize: DEFAULT_PAGE_SIZE,
  };
}

// ---- Fields ----

const BUILTIN_SET: ReadonlySet<string> = new Set(BUILTIN_FIELDS);

export function isRowField(field: string): field is RowField {
  return field.startsWith('row.') && field.length > 4;
}
export function isViewField(field: string): field is ViewField {
  return BUILTIN_SET.has(field) || isRowField(field);
}
export function rowField(path: string): RowField {
  return `row.${path}`;
}
export function rowPath(field: RowField): string {
  return field.slice(4);
}
export function isRowFilter(filter: ViewFilter): filter is RowFilter {
  return isRowField(filter.field);
}

/** What the Resource column shows for a finding: a state finding's resource name (falling back to
 *  the tail of its resource id), or an activity finding's dimension key, since there is no
 *  resource to name. The `resourceName` filter and sort read this, so a header funnel offers
 *  exactly the labels on screen. */
export function findingSubject(f: { resourceName?: string; dimensionKey?: string; resourceId?: string }): string {
  return f.resourceName || f.dimensionKey || f.resourceId?.split('/').pop() || '';
}

/** What a finding is about, for counting distinct resources: its resource id (ARM ids compare
 *  case-insensitively), else an activity finding's dimension key, else the finding itself. Two rules
 *  that flag the same VM are two findings on one resource. */
export function resourceKey(f: { fingerprint: string; resourceId?: string; dimensionKey?: string }): string {
  if (f.resourceId) return `id:${f.resourceId.toLowerCase()}`;
  if (f.dimensionKey) return `dim:${f.dimensionKey}`;
  return `fp:${f.fingerprint}`;
}

/** How many distinct resources the findings are on. */
export function countResources(findings: Iterable<{ fingerprint: string; resourceId?: string; dimensionKey?: string }>): number {
  const keys = new Set<string>();
  for (const f of findings) keys.add(resourceKey(f));
  return keys.size;
}

/** The accepted values of the filter on `field`, empty when the view has none there. */
export function filterValues(filters: readonly ViewFilter[], field: ViewField): string[] {
  return filters.find(f => f.field === field)?.values ?? [];
}

// ---- Reading a row ----

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A value inside a row by dot path (`properties.sku`). A key that itself contains dots wins over
 *  the nested reading, so a column named `a.b` is still reachable. Undefined when the path leads
 *  nowhere, which is how a column no finding has stays empty rather than an error. */
export function readPath(value: unknown, path: string): unknown {
  if (!isObject(value) || path === '') return undefined;
  if (Object.hasOwn(value, path)) return value[path];
  for (let i = path.indexOf('.'); i >= 0; i = path.indexOf('.', i + 1)) {
    const head = path.slice(0, i);
    if (!Object.hasOwn(value, head)) continue;
    const found = readPath(value[head], path.slice(i + 1));
    if (found !== undefined) return found;
  }
  return undefined;
}

const MAX_LEAF_DEPTH = 3;

/** Every column the findings' rows returned, as dot paths, sorted. Nested objects are walked to
 *  three levels; an array, or an object nested deeper, is one column. `_rule` is the visual
 *  builder's own metadata, not data a query returned. */
export function rowLeafPaths(findings: readonly { rows?: FindingRow[] | null; evidence?: FindingRow | null }[]): string[] {
  const paths = new Set<string>();
  const walk = (value: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [key, child] of Object.entries(value)) {
      if (depth === 1 && key === '_rule') continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (isObject(child) && depth < MAX_LEAF_DEPTH && Object.keys(child).length > 0) walk(child, path, depth + 1);
      else paths.add(path);
    }
  };
  for (const f of findings) for (const row of findingRows(f)) walk(row, '', 1);
  return [...paths].sort((a, b) => a.localeCompare(b));
}

// ---- Values as shown ----

export type CellValue =
  | { kind: 'empty' }
  | { kind: 'url'; text: string; href: string }
  | { kind: 'json'; text: string }
  | { kind: 'text'; text: string };

const URL_PATTERN = /^https?:\/\/\S+$/i;

/** How a returned value is shown: an http or https URL as a link, an object or array as compact
 *  JSON, null, undefined and '' as empty, anything else as its text. */
export function classifyValue(value: unknown): CellValue {
  if (value === null || value === undefined || value === '') return { kind: 'empty' };
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return URL_PATTERN.test(trimmed) ? { kind: 'url', text: trimmed, href: trimmed } : { kind: 'text', text: value };
  }
  if (typeof value === 'object') return { kind: 'json', text: JSON.stringify(value) };
  return { kind: 'text', text: String(value) };
}

/** A value as text, for comparing: the same text `classifyValue` shows. */
export function valueText(value: unknown): string {
  const cell = classifyValue(value);
  return cell.kind === 'empty' ? '' : cell.text;
}

/** One cell of the flat list: the first distinct value a finding's shown rows hold for the column,
 *  and how many other distinct values they hold. Empty values are not values. */
export function columnCell(rows: readonly FindingRow[], path: string): { value: CellValue; more: number } {
  const seen = new Set<string>();
  let first: CellValue = { kind: 'empty' };
  for (const row of rows) {
    const cell = classifyValue(readPath(row, path));
    if (cell.kind === 'empty' || seen.has(cell.text)) continue;
    if (seen.size === 0) first = cell;
    seen.add(cell.text);
  }
  return { value: first, more: Math.max(0, seen.size - 1) };
}

// ---- Filtering ----

/** The rows of a finding that pass every row filter, in order. Every row when there is none. */
export function matchingRows(finding: ViewFinding, rowFilters: readonly RowFilter[]): FindingRow[] {
  const rows = findingRows(finding);
  if (rowFilters.length === 0) return rows;
  return rows.filter(row => rowFilters.every(filter => rowMatches(row, filter)));
}

export function rowMatches(row: FindingRow, filter: RowFilter): boolean {
  return filter.values.includes(valueText(readPath(row, rowPath(filter.field))));
}

const EXPLORER_DIMS: readonly ExplorerFilterDim[] = ['severity', 'status', 'subscription', 'resourceGroup', 'location', 'tags'];

/** Whether a row filter constrains anything. One with no values accepts everything. */
function isActiveRowFilter(filter: RowFilter): boolean {
  return filter.values.length > 0;
}

export function activeRowFilters(filters: readonly ViewFilter[], except?: ReadonlySet<ViewField>): RowFilter[] {
  return filters.filter(isRowFilter).filter(f => isActiveRowFilter(f) && !except?.has(f.field));
}

/** The findings that pass `spec`'s filters. `except` leaves some fields out, which is how a
 *  dropdown counts its options (every filter but its own) and how the header tiles stay a stable
 *  reference while severity and status are toggled. Suppressed findings are dropped unless
 *  `ctx.showSuppressed`. */
export function filterFindings<T extends ViewFinding>(
  findings: readonly T[],
  spec: ViewFilterSpec,
  ctx: ViewContext = {},
  opts: { except?: ReadonlySet<ViewField> } = {},
): T[] {
  const except = opts.except;
  const builtin = spec.filters.filter((f): f is BuiltinFilter => !isRowFilter(f) && !except?.has(f.field));
  const values = (field: BuiltinField) => new Set(filterValues(builtin, field));
  const range = ctx.range ?? resolveDateWindow(spec.window);

  const state: ExplorerFilterState = {
    showSuppressed: ctx.showSuppressed ?? false,
    suppressedFingerprints: new Set(ctx.suppressedFingerprints ?? []),
    categories: values('category'),
    severities: values('severity') as Set<Severity>,
    status: parseExplorerStatus(filterValues(builtin, 'status')[0]),
    ruleIds: values('rule'),
    subscriptions: values('subscription'),
    resourceGroups: values('resourceGroup'),
    locations: values('location'),
    tags: values('tags'),
    search: spec.search,
    rangeFrom: range.from,
    rangeTo: range.to,
  };
  const exclude = new Set(EXPLORER_DIMS.filter(dim => except?.has(dim)));
  const kinds = values('kind');
  const types = values('resourceType');
  const names = values('resourceName');
  const firstSeen = values('firstSeen');
  const lastSeen = values('lastSeen');
  const rowFilters = activeRowFilters(spec.filters, except);

  return findings.filter(f =>
    matchesExplorerFilters(f, state, exclude)
    && (kinds.size === 0 || kinds.has(f.kind ?? 'state'))
    && (types.size === 0 || types.has(f.resourceType ?? ''))
    && (names.size === 0 || names.has(findingSubject(f)))
    && (firstSeen.size === 0 || firstSeen.has(f.firstSeenAt.slice(0, 10)))
    && (lastSeen.size === 0 || lastSeen.has(f.lastSeenAt.slice(0, 10)))
    && (rowFilters.length === 0 || matchingRows(f, rowFilters).length > 0),
  );
}

// ---- Sorting ----

// Severity ranks by SEVERITY_ORDER, the one ordering the dashboard code shares.
function sortValue(item: ViewItem<ViewFinding>, field: ViewField): string | number | undefined {
  if (isRowField(field)) {
    const value = readPath(item.rows[0], rowPath(field));
    return typeof value === 'number' ? value : valueText(value);
  }
  const f = item.finding;
  switch (field) {
    case 'rule': return f.policyName ?? f.title;
    case 'kind': return f.kind ?? 'state';
    case 'category': return f.category;
    case 'severity': return SEVERITY_ORDER.indexOf(f.severity);
    case 'status': return f.status;
    case 'subscription': return subscriptionValue(f);
    case 'resourceGroup': return f.resourceGroup;
    case 'location': return f.location;
    case 'resourceType': return f.resourceType;
    case 'resourceName': return findingSubject(f);
    case 'tags': return (f.ruleTags ?? []).join(',');
    case 'firstSeen': return f.firstSeenAt;
    case 'lastSeen': return f.lastSeenAt;
  }
}

const isEmptyValue = (v: string | number | undefined) => v === undefined || v === '';

export function compareBy(a: ViewItem<ViewFinding>, b: ViewItem<ViewFinding>, sort: ViewSort | undefined): number {
  if (!sort) return 0;
  const av = sortValue(a, sort.field);
  const bv = sortValue(b, sort.field);
  const aEmpty = isEmptyValue(av);
  const bEmpty = isEmptyValue(bv);
  // Empty values sort last whichever way the column runs, so they are not flipped with the rest.
  if (aEmpty || bEmpty) return aEmpty === bEmpty ? compareBy(a, b, sort.then) : aEmpty ? 1 : -1;
  const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
  if (cmp !== 0) return sort.dir === 'asc' ? cmp : -cmp;
  return compareBy(a, b, sort.then);
}

// ---- The engine ----

/** Filters, sorts and pages `findings`. A finding keeps only the rows that pass the view's row
 *  filters, and a sort on a returned column reads the first of those. */
export function applyView<T extends ViewFinding>(findings: readonly T[], view: View, ctx: ViewContext = {}): ViewPage<T> {
  const rowFilters = activeRowFilters(view.filters);
  const matchedItems = filterFindings(findings, view, ctx)
    .map(finding => ({ finding, rows: matchingRows(finding, rowFilters) }));
  const sort = view.sort ?? DEFAULT_SORT;
  const matched = [...matchedItems].sort((a, b) => compareBy(a, b, sort));

  const pageSize = Math.max(1, Math.floor(view.pageSize) || DEFAULT_PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(matched.length / pageSize));
  const page = Math.min(Math.max(1, Math.floor(view.page) || 1), pageCount);
  return {
    items: matched.slice((page - 1) * pageSize, page * pageSize),
    total: matched.length,
    page,
    pageCount,
    matched,
  };
}

/** The values a returned column holds across `findings`, each with how many findings hold it, for a
 *  header filter's option list. Counted over the rows that pass every other row filter, so picking
 *  one value never hides the others. */
export function rowFieldOptions<T extends ViewFinding>(
  findings: readonly T[],
  filters: readonly ViewFilter[],
  path: string,
): { value: string; count: number }[] {
  const others = activeRowFilters(filters, new Set([rowField(path)]));
  const counts = new Map<string, number>();
  for (const f of findings) {
    const own = new Set<string>();
    for (const row of matchingRows(f, others)) {
      const text = valueText(readPath(row, path));
      if (text !== '') own.add(text);
    }
    for (const text of own) counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => a.value.localeCompare(b.value));
}

/** The values a finding holds on a built-in field, as the filter on that field compares them. */
export function builtinFieldValues(f: ViewFinding, field: BuiltinField): string[] {
  switch (field) {
    case 'rule': return [f.ruleId];
    case 'kind': return [f.kind ?? 'state'];
    case 'category': return [f.category];
    case 'severity': return [f.severity];
    case 'status': return [f.status];
    case 'subscription': return [subscriptionValue(f)];
    case 'resourceGroup': return [f.resourceGroup ?? ''];
    case 'location': return [f.location ?? ''];
    case 'resourceType': return [f.resourceType ?? ''];
    case 'resourceName': return [findingSubject(f)];
    case 'tags': return f.ruleTags ?? [];
    case 'firstSeen': return [f.firstSeenAt.slice(0, 10)];
    case 'lastSeen': return [f.lastSeenAt.slice(0, 10)];
  }
}

/** The values `findings` hold on a built-in field, each with how many findings hold it, for an
 *  option list. A finding with a blank value on the field is not counted. */
export function fieldOptions<T extends ViewFinding>(
  findings: readonly T[],
  field: BuiltinField,
): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const f of findings) {
    for (const value of new Set(builtinFieldValues(f, field))) {
      if (value !== '') counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => a.value.localeCompare(b.value));
}

/** Toggles one accepted value on a field's filter, adding the filter when the field had none and
 *  removing it when nothing is left. Works the same for a built-in field and a returned column. */
export function toggleFilterValue(filters: readonly ViewFilter[], field: ViewField, value: string): ViewFilter[] {
  const others = filters.filter(f => f.field !== field);
  const current = filterValues(filters, field);
  const values = current.includes(value) ? current.filter(v => v !== value) : [...current, value];
  return values.length > 0 ? [...others, { field, values } as ViewFilter] : others;
}

/** Removes every filter on a field. */
export function clearFilter(filters: readonly ViewFilter[], field: ViewField): ViewFilter[] {
  return filters.filter(f => f.field !== field);
}

// ---- Grouping ----

/** Resolves what a built-in field's value is called on screen, such as a rule id to its name. The
 *  engine never builds labels itself; it only orders groups by what the caller says they read as. */
export interface GroupOptions {
  labelFor?: (field: ViewField, value: string) => string;
}

/** One group: a value of the group field, how many findings, resources and rows fall in it, and either the
 *  groups of the next field (`groups`) or, at the last field, the findings themselves (`items`),
 *  each with only the rows that fell in this group. The other of the two is empty. */
export interface ViewGroup<T> {
  field: ViewField;
  /** Null is the empty-value group: rows with no value for the field. It always sorts last. */
  value: string | null;
  /** Distinct findings in the group. A finding is in every group its rows fall into. */
  findingCount: number;
  /** Distinct resources those findings are on (`resourceKey`). Never more than `findingCount`. */
  resourceCount: number;
  rowCount: number;
  groups: ViewGroup<T>[];
  items: ViewItem<T>[];
}

export interface GroupedViewPage<T> {
  /** The requested page of top-level groups. */
  groups: ViewGroup<T>[];
  /** Top-level groups, across every page. */
  groupTotal: number;
  /** Findings that match and rows they hold, whichever group they fall in. */
  total: number;
  rowTotal: number;
  /** The page returned, 1-based and clamped into range. */
  page: number;
  pageCount: number;
}

export interface ItemsPage<T> {
  items: ViewItem<T>[];
  total: number;
  page: number;
  pageCount: number;
}

export function clampPage(total: number, page: number, pageSize: number): { page: number; pageCount: number; pageSize: number } {
  const size = Math.max(1, Math.floor(pageSize) || DEFAULT_PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(total / size));
  return { page: Math.min(Math.max(1, Math.floor(page) || 1), pageCount), pageCount, pageSize: size };
}

/** The values one finding falls under for a group field, each with the rows that fall there. A
 *  built-in field holds all of a finding's rows under each value it has (a finding with several
 *  tags is under each tag); a returned column puts each row under its own value. No value is null. */
export function groupParts(item: ViewItem<ViewFinding>, field: ViewField): { value: string | null; rows: FindingRow[] }[] {
  if (!isRowField(field)) {
    const values = [...new Set(builtinFieldValues(item.finding, field))].filter(v => v !== '');
    return values.length > 0 ? values.map(value => ({ value, rows: item.rows })) : [{ value: null, rows: item.rows }];
  }
  if (item.rows.length === 0) return [{ value: null, rows: [] }];
  const parts = new Map<string | null, FindingRow[]>();
  for (const row of item.rows) {
    const text = valueText(readPath(row, rowPath(field)));
    const value = text === '' ? null : text;
    const bucket = parts.get(value);
    if (bucket) bucket.push(row);
    else parts.set(value, [row]);
  }
  return [...parts].map(([value, rows]) => ({ value, rows }));
}

const compareText = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** Built-in fields whose stored value is an id or a code, not what the header says. Groups of these
 *  order by the label. The others read the same on screen as they are stored (a day is ISO, so it
 *  orders as the date it shows), and a returned column is shown as it is stored. */
const LABELLED_FIELDS: ReadonlySet<ViewField> = new Set<ViewField>(['rule', 'kind', 'category', 'subscription']);

/** Orders two non-empty group values the way the header shows them: severity by the ramp the flat
 *  sort uses (anything off the ramp last), a labelled field by its label, the rest by the value. Ties
 *  fall back to the stored value so the order never depends on the order findings arrived in. */
function compareGroupValues(field: ViewField, a: string, b: string, labelFor: GroupOptions['labelFor']): number {
  if (field === 'severity') {
    const rank = (v: string) => { const i = SEVERITY_ORDER.indexOf(v as Severity); return i < 0 ? SEVERITY_ORDER.length : i; };
    return rank(a) - rank(b) || compareText(a, b);
  }
  if (labelFor && LABELLED_FIELDS.has(field)) return compareText(labelFor(field, a), labelFor(field, b)) || compareText(a, b);
  return compareText(a, b);
}

/** What ordering two groups reads: the field, the value and how many findings fall in it. */
export type GroupKey = Pick<ViewGroup<ViewFinding>, 'field' | 'value' | 'findingCount'>;

/** Groups order by `groupSort`, the empty-value group last whichever way it runs (and, sorting by
 *  value, a severity off the ramp too). Equal counts keep
 *  value order, so the order never depends on the order findings arrived in. */
export function compareGroups(a: GroupKey, b: GroupKey, sort: GroupSort, labelFor: GroupOptions['labelFor']): number {
  if (a.value === null || b.value === null) return a.value === b.value ? 0 : a.value === null ? 1 : -1;
  // A severity off the ramp goes last whichever way the ramp runs, like the empty-value group.
  if (sort.by === 'value' && a.field === 'severity') {
    const offA = !SEVERITY_ORDER.includes(a.value as Severity);
    const offB = !SEVERITY_ORDER.includes(b.value as Severity);
    if (offA !== offB) return offA ? 1 : -1;
  }
  const byValue = compareGroupValues(a.field, a.value, b.value, labelFor);
  if (sort.by === 'value') return sort.dir === 'asc' ? byValue : -byValue;
  const byCount = a.findingCount - b.findingCount;
  return byCount !== 0 ? (sort.dir === 'asc' ? byCount : -byCount) : byValue;
}

function buildGroups<T extends ViewFinding>(
  items: ViewItem<T>[], fields: readonly ViewField[], groupSort: GroupSort, sort: ViewSort, labelFor: GroupOptions['labelFor'],
): ViewGroup<T>[] {
  const [field, ...rest] = fields;
  const buckets = new Map<string | null, ViewItem<T>[]>();
  for (const item of items) {
    for (const part of groupParts(item, field)) {
      const bucket = buckets.get(part.value);
      const member = { finding: item.finding, rows: part.rows };
      if (bucket) bucket.push(member);
      else buckets.set(part.value, [member]);
    }
  }
  return [...buckets]
    .map(([value, members]): ViewGroup<T> => ({
      field,
      value,
      findingCount: members.length,
      resourceCount: countResources(members.map(m => m.finding)),
      rowCount: members.reduce((n, m) => n + m.rows.length, 0),
      groups: rest.length > 0 ? buildGroups(members, rest, groupSort, sort, labelFor) : [],
      items: rest.length > 0 ? [] : [...members].sort((a, b) => compareBy(a, b, sort)),
    }))
    .sort((a, b) => compareGroups(a, b, groupSort, labelFor));
}

/** Filters `findings` like `applyView`, then buckets the matching rows by `view.groupBy`, outermost
 *  field first. Filters run before grouping, so only matching rows are bucketed. The top-level groups
 *  are paged by `view.page` and `view.pageSize`; the rows inside a last-level group are paged by the
 *  caller with `pageGroupItems`, each group on its own page. Items inside a group follow `view.sort`.
 *  With no `groupBy` there are no groups: the flat list is `applyView`. `options.labelFor` lets a
 *  sort by value follow the label a header shows; without it the stored value is compared. */
export function applyGroupedView<T extends ViewFinding>(
  findings: readonly T[], view: View, ctx: ViewContext = {}, options: GroupOptions = {},
): GroupedViewPage<T> {
  const rowFilters = activeRowFilters(view.filters);
  const items = filterFindings(findings, view, ctx).map(finding => ({ finding, rows: matchingRows(finding, rowFilters) }));
  const all = view.groupBy.length > 0 ? buildGroups(items, view.groupBy, view.groupSort, view.sort ?? DEFAULT_SORT, options.labelFor) : [];
  const { page, pageCount, pageSize } = clampPage(all.length, view.page, view.pageSize);
  return {
    groups: all.slice((page - 1) * pageSize, page * pageSize),
    groupTotal: all.length,
    total: items.length,
    rowTotal: items.reduce((n, item) => n + item.rows.length, 0),
    page,
    pageCount,
  };
}

/** One page of a group's items. `page` is that group's own page number, 1-based, clamped. */
export function pageGroupItems<T>(items: readonly ViewItem<T>[], page: number, pageSize = DEFAULT_PAGE_SIZE): ItemsPage<T> {
  const clamped = clampPage(items.length, page, pageSize);
  return {
    items: items.slice((clamped.page - 1) * clamped.pageSize, clamped.page * clamped.pageSize),
    total: items.length,
    page: clamped.page,
    pageCount: clamped.pageCount,
  };
}

// ---- URL ----

type ParamSource = URLSearchParams | Record<string, string | string[] | undefined>;

/** The builtin fields with a short param of their own, kept exactly as the page has always read them. */
const LIST_PARAMS: Partial<Record<BuiltinField, string>> = {
  category: 'category', rule: 'ruleId', severity: 'severity', subscription: 'subscription',
  resourceGroup: 'rg', location: 'location', tags: 'tags',
};
/** The built-in fields with no short param of their own (`status` has one). They travel as
 *  repeated `f=field=v1|v2`. */
export const GENERIC_FIELDS: readonly BuiltinField[] = BUILTIN_FIELDS.filter(f => f !== 'status' && !LIST_PARAMS[f]);

const MAX_URL_PAGE = 1_000_000;

function readParam(source: ParamSource, name: string): string | undefined {
  return readParams(source, name)[0];
}
function readParams(source: ParamSource, name: string): string[] {
  if (source instanceof URLSearchParams) return source.getAll(name);
  const raw = source[name];
  return raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
}

// A param that holds a list (`a,b`), a value set (`v1|v2`) or a name and its values (`path=v1|v2`)
// escapes the three delimiters, and the backslash itself, with a backslash. Nothing is
// percent-encoded here: URLSearchParams does that once when the query is written and undoes it
// when it is read, so a plain space is `+` and a hand-written value with a bare `%` is kept as typed.
function esc(text: string): string {
  return text.replace(/[\\,|=]/g, '\\$&');
}
function unesc(piece: string): string {
  return piece.replace(/\\([\s\S])/g, '$1');
}
/** Splits at each `delimiter` that is not escaped. The pieces are still escaped. */
function splitEscaped(text: string, delimiter: string): string[] {
  const pieces: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) current += ch + text[++i];
    else if (ch === delimiter) { pieces.push(current); current = ''; }
    else current += ch;
  }
  pieces.push(current);
  return pieces;
}
/** The values of a `v1|v2` set, empty ones included: `rf` can ask for the rows where a column is blank. */
function readValues(text: string): string[] {
  return splitEscaped(text, '|').map(unesc);
}
/** The pieces of a `a,b` list, empty ones included. */
function listPieces(value: string): string[] {
  return splitEscaped(value, ',').map(unesc);
}
function splitList(value: string | undefined): string[] {
  return value ? listPieces(value).filter(Boolean) : [];
}
/** `name=values` as written by `esc(name)=esc(v1)|esc(v2)`. A value may hold a bare `=`, as typed by hand. */
function readNamedValues(raw: string): { name: string; values: string[] } | undefined {
  const [head, ...rest] = splitEscaped(raw, '=');
  const name = unesc(head);
  return rest.length > 0 && name !== '' ? { name, values: readValues(rest.join('=')) } : undefined;
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** A View as query params, with `base` (params the page itself owns, such as `tab`) kept first.
 *  Defaults are left out, so a default view is an empty query. */
export function viewToSearchParams(view: View, base?: ParamSource): URLSearchParams {
  const params = new URLSearchParams();
  if (base instanceof URLSearchParams) base.forEach((v, k) => params.append(k, v));
  else if (base) for (const [k, v] of Object.entries(base)) for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) params.append(k, one);

  const builtin = (field: BuiltinField) => filterValues(view.filters, field);
  for (const field of BUILTIN_FIELDS) {
    const name = LIST_PARAMS[field];
    if (name && builtin(field).length > 0) params.set(name, builtin(field).map(esc).join(','));
  }
  const status = parseExplorerStatus(builtin('status')[0]);
  if (status !== 'open') params.set('status', status);

  for (const field of GENERIC_FIELDS) {
    if (builtin(field).length > 0) params.append('f', `${field}=${builtin(field).map(esc).join('|')}`);
  }

  if (view.window.mode === 'custom') {
    params.set('from', view.window.from);
    params.set('to', view.window.to);
  } else if (view.window.days !== DEFAULT_WINDOW_DAYS) {
    params.set('window', String(view.window.days));
  }
  if (view.search !== '') params.set('q', view.search);

  if (view.columns.length > 0) params.set('cols', view.columns.map(esc).join(','));
  if (view.sort) params.set('sort', `${view.sort.field}:${view.sort.dir}`);
  if (view.groupBy.length > 0) params.set('group', view.groupBy.map(esc).join(','));
  if (view.groupSort.by !== DEFAULT_GROUP_SORT.by || view.groupSort.dir !== DEFAULT_GROUP_SORT.dir) {
    params.set('gsort', `${view.groupSort.by}:${view.groupSort.dir}`);
  }
  for (const filter of view.filters.filter(isRowFilter).filter(isActiveRowFilter)) {
    params.append('rf', `${esc(rowPath(filter.field))}=${filter.values.map(esc).join('|')}`);
  }
  if (view.page > 1) params.set('page', String(view.page));
  return params;
}

/** The View a query holds. Anything unknown or malformed is ignored rather than rejected, so an old
 *  or hand-edited link still opens. Filters come back built-in fields first, in BUILTIN_FIELDS
 *  order, then returned columns in the order they were given. */
export function viewFromSearchParams(source: ParamSource): View {
  const view = emptyView();
  const filters: ViewFilter[] = [];
  const lists: Record<string, string[]> = {
    category: parseCategoryParam(readParam(source, 'category')),
    rule: splitList(readParam(source, 'ruleId')),
    severity: splitList(readParam(source, 'severity')).filter(s => (EXPLORER_SEVERITIES as string[]).includes(s)),
    subscription: splitList(readParam(source, 'subscription')),
    resourceGroup: splitList(readParam(source, 'rg')),
    location: splitList(readParam(source, 'location')),
    tags: splitList(readParam(source, 'tags')),
  };
  const status = parseExplorerStatus(readParam(source, 'status'));
  lists.status = status === 'open' ? [] : [status];
  for (const raw of readParams(source, 'f')) {
    const named = readNamedValues(raw);
    if (!named || !(GENERIC_FIELDS as readonly string[]).includes(named.name)) continue;
    const values = named.values.filter(v => v !== '');
    if (values.length > 0) lists[named.name] = values;
  }
  for (const field of BUILTIN_FIELDS) {
    if (lists[field]?.length) filters.push({ field, values: lists[field] });
  }

  for (const raw of readParams(source, 'rf')) {
    const named = readNamedValues(raw);
    if (named) filters.push({ field: rowField(named.name), values: named.values });
  }
  view.filters = filters;

  const days = Number(readParam(source, 'window'));
  const from = readParam(source, 'from');
  const to = readParam(source, 'to');
  if (from && to && DAY_KEY.test(from) && DAY_KEY.test(to)) view.window = { mode: 'custom', from, to };
  else if (Number.isInteger(days) && days > 0) view.window = { mode: 'relative', days };
  view.search = readParam(source, 'q') ?? '';

  view.columns = [...new Set(splitList(readParam(source, 'cols')))];
  const sort = readParam(source, 'sort');
  const colon = sort ? sort.lastIndexOf(':') : -1;
  if (sort && colon > 0) {
    const field = sort.slice(0, colon);
    const dir = sort.slice(colon + 1);
    if (isViewField(field) && (dir === 'asc' || dir === 'desc')) view.sort = { field, dir };
  }
  view.groupBy = [...new Set(splitList(readParam(source, 'group')).filter(isViewField))];
  const [groupBy, groupDir] = (readParam(source, 'gsort') ?? '').split(':');
  if ((groupBy === 'value' || groupBy === 'count') && (groupDir === 'asc' || groupDir === 'desc')) {
    view.groupSort = { by: groupBy, dir: groupDir };
  }
  const page = Number(readParam(source, 'page'));
  if (Number.isInteger(page) && page > 1 && page <= MAX_URL_PAGE) view.page = page;
  return view;
}

// ---- Dashboard filter changes in the URL (ADR 0013) ----

/** The dimensions a dashboard filters by. `includeSuppressed` is not one: it is the viewer's
 *  toggle and never travels in an address. */
export interface DashboardFilters {
  category: string[];
  subscription: string[];
  resourceGroup: string[];
  tags: string[];
  rule: string[];
  severity: string[];
  window: DateWindow;
}

/** A layer of changes on top of the saved filters. A dimension that is present replaces the saved
 *  value (an empty list is the explicit "any"), and one that is missing inherits it. */
export type DashboardFilterChanges = Partial<DashboardFilters>;

type DashboardListDim = Exclude<keyof DashboardFilters, 'window'>;

/** The /scans param each dashboard dimension is written under. */
const DASHBOARD_LIST_PARAMS: Record<DashboardListDim, string> = {
  category: 'category', subscription: 'subscription', resourceGroup: 'rg', tags: 'tags', rule: 'ruleId', severity: 'severity',
};
const DASHBOARD_LIST_DIMS = Object.keys(DASHBOARD_LIST_PARAMS) as DashboardListDim[];
/** The params that carry `includeSuppressed`. They never travel in a dashboard address, so a base that holds one loses it. */
const VIEWER_TOGGLE_PARAMS = ['suppressed', 'includeSuppressed'];
const DASHBOARD_PARAMS = [...Object.values(DASHBOARD_LIST_PARAMS), 'window', 'from', 'to'];

/** Whether a value can be named by a dashboard dimension; the rest are ignored, as in `/scans`. */
const DASHBOARD_VALUE_OK: Partial<Record<DashboardListDim, (value: string) => boolean>> = {
  category: value => value !== 'all',
  severity: value => (EXPLORER_SEVERITIES as string[]).includes(value),
};

/** `undefined` inherits. An empty param is "any" (`[]`). A param that holds only values the
 *  dimension cannot use counts as missing, never as "any". */
function readDashboardList(source: ParamSource, dim: DashboardListDim): string[] | undefined {
  const raw = readParam(source, DASHBOARD_LIST_PARAMS[dim]);
  if (raw === undefined) return undefined;
  if (raw === '') return [];
  const ok = DASHBOARD_VALUE_OK[dim];
  const values = [...new Set(listPieces(raw).filter(v => v !== '' && (!ok || ok(v))))];
  return values.length > 0 ? values : undefined;
}

function readDashboardWindow(source: ParamSource): DateWindow | undefined {
  const from = readParam(source, 'from');
  const to = readParam(source, 'to');
  if (from && to && DAY_KEY.test(from) && DAY_KEY.test(to)) return { mode: 'custom', from, to };
  const days = Number(readParam(source, 'window'));
  return Number.isInteger(days) && days > 0 ? { mode: 'relative', days } : undefined;
}

/** Values compare as sets: duplicates and order do not count. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every(v => right.has(v));
}

function sameWindow(a: DateWindow, b: DateWindow): boolean {
  return a.mode === 'custom' ? b.mode === 'custom' && a.from === b.from && a.to === b.to : b.mode === 'relative' && a.days === b.days;
}

/** The reader and writer of a dashboard's filter changes, against the filters saved on it. */
export function dashboardAddress(saved: DashboardFilters): {
  /** The changes an address holds. Anything unknown or malformed is ignored. */
  read(source: ParamSource): DashboardFilterChanges;
  /** The changes as query params, with `base` (params the page owns, such as `tab`) kept first. A
   *  dimension equal to its saved value is left out, and so is any dashboard param `base` carries. */
  write(changes: DashboardFilterChanges, base?: ParamSource): URLSearchParams;
} {
  return {
    read(source) {
      const changes: DashboardFilterChanges = {};
      for (const dim of DASHBOARD_LIST_DIMS) {
        const values = readDashboardList(source, dim);
        if (values) changes[dim] = values;
      }
      const window = readDashboardWindow(source);
      if (window) changes.window = window;
      return changes;
    },
    write(changes, base) {
      const params = new URLSearchParams();
      if (base instanceof URLSearchParams) base.forEach((v, k) => params.append(k, v));
      else if (base) for (const [k, v] of Object.entries(base)) for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) params.append(k, one);
      for (const name of [...DASHBOARD_PARAMS, ...VIEWER_TOGGLE_PARAMS]) params.delete(name);

      for (const dim of DASHBOARD_LIST_DIMS) {
        const values = changes[dim];
        if (values && !sameSet(values, saved[dim])) params.set(DASHBOARD_LIST_PARAMS[dim], [...new Set(values)].map(esc).join(','));
      }
      const window = changes.window;
      if (window && !sameWindow(window, saved.window)) {
        if (window.mode === 'custom') {
          params.set('from', window.from);
          params.set('to', window.to);
        } else {
          params.set('window', String(window.days));
        }
      }
      return params;
    },
  };
}

// ---- A saved view's filter changes in the URL (ADR 0013) ----

const STATUS_VALUES = ['open', 'new', 'fixed', 'all', 'active'];

/** `undefined` inherits. The empty value is Any (`[]`). A param of only values `ok` refuses counts as
 *  missing, never as Any. */
function readLayerList(raw: string | undefined, ok: (value: string) => boolean = () => true): string[] | undefined {
  if (raw === undefined) return undefined;
  if (raw === '') return [];
  const values = [...new Set(listPieces(raw).filter(v => v !== '' && ok(v)))];
  return values.length > 0 ? values : undefined;
}

function setFilter(filters: Map<ViewField, string[]>, field: ViewField, values: string[]): void {
  if (values.length === 0) filters.delete(field);
  else filters.set(field, values);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const effectiveSort = (sort: ViewSort | null): ViewSort => sort ?? DEFAULT_SORT;

/**
 * The reader and writer of the changes a /scans address holds on top of an open saved view. Every part
 * a saved view keeps is a layer: each list param, each `f=<field>`, each `rf=<path>` keyed by path,
 * `q`, `status`, the window, `cols`, `sort`, `group` and `gsort`. A part the address names replaces the
 * saved one (never intersects), and one it does not name is inherited, so a link follows the view's
 * later updates and a part that arrives malformed cannot widen it.
 *
 * Any is the empty value (`severity=`, `f=kind=`, `q=`, `cols=`, `group=`), and for a returned column
 * `rf=<path>` with no `=` (`rf=<path>=` still means the rows where it is blank). `status`, `sort`,
 * `gsort` and the window have no Any and are written in full when they differ. `page` is where the
 * viewer is, not part of a view: it is read and written as navigation and never compared.
 */
export function savedViewAddress(saved: View): {
  /** The saved view with the changes `source` holds applied: the effective View. */
  read(source: ParamSource): View;
  /** The changes `current` makes to the saved view as query params, with `base` (params the page owns,
   *  such as `tab` and `view`) kept first. */
  write(current: View, base?: ParamSource): URLSearchParams;
} {
  return {
    read(source) {
      const view = emptyView();
      const filters = new Map<ViewField, string[]>(saved.filters.map(f => [f.field, [...f.values]]));

      for (const field of BUILTIN_FIELDS) {
        const name = LIST_PARAMS[field];
        if (!name) continue;
        const ok = field === 'category' ? (v: string) => v !== 'all'
          : field === 'severity' ? (v: string) => (EXPLORER_SEVERITIES as string[]).includes(v)
          : undefined;
        const values = readLayerList(readParam(source, name), ok);
        if (values) setFilter(filters, field, values);
      }
      const status = readParam(source, 'status');
      if (status !== undefined && STATUS_VALUES.includes(status)) {
        const parsed = parseExplorerStatus(status);
        setFilter(filters, 'status', parsed === 'open' ? [] : [parsed]);
      }
      for (const raw of readParams(source, 'f')) {
        const named = readNamedValues(raw);
        if (!named || !(GENERIC_FIELDS as readonly string[]).includes(named.name)) continue;
        const field = named.name as BuiltinField;
        if (named.values.length === 1 && named.values[0] === '') { filters.delete(field); continue; }
        const values = named.values.filter(v => v !== '');
        if (values.length > 0) filters.set(field, values);
      }
      for (const raw of readParams(source, 'rf')) {
        const [head, ...rest] = splitEscaped(raw, '=');
        const path = unesc(head);
        if (path === '') continue;
        if (rest.length === 0) filters.delete(rowField(path));
        else filters.set(rowField(path), readValues(rest.join('=')));
      }
      const builtin = BUILTIN_FIELDS.filter(f => filters.has(f)).map(field => ({ field, values: filters.get(field)! }) as ViewFilter);
      const returned = [...filters].filter(([field]) => isRowField(field)).map(([field, values]) => ({ field, values }) as ViewFilter);
      view.filters = [...builtin, ...returned];

      view.window = readDashboardWindow(source) ?? saved.window;
      view.search = readParam(source, 'q') ?? saved.search;
      view.columns = readLayerList(readParam(source, 'cols')) ?? saved.columns;

      const sort = readParam(source, 'sort');
      const colon = sort ? sort.lastIndexOf(':') : -1;
      let nextSort = saved.sort;
      if (sort && colon > 0) {
        const field = sort.slice(0, colon);
        const dir = sort.slice(colon + 1);
        if (isViewField(field) && (dir === 'asc' || dir === 'desc')) nextSort = { field, dir };
      }
      const sorted = effectiveSort(nextSort);
      view.sort = sorted.field === DEFAULT_SORT.field && sorted.dir === DEFAULT_SORT.dir ? null : sorted;

      view.groupBy = readLayerList(readParam(source, 'group'), isViewField) as ViewField[] | undefined ?? saved.groupBy;
      const [by, dir] = (readParam(source, 'gsort') ?? '').split(':');
      view.groupSort = (by === 'value' || by === 'count') && (dir === 'asc' || dir === 'desc') ? { by, dir } : saved.groupSort;

      const page = Number(readParam(source, 'page'));
      if (Number.isInteger(page) && page > 1 && page <= MAX_URL_PAGE) view.page = page;
      return view;
    },

    write(current, base) {
      const params = new URLSearchParams();
      if (base instanceof URLSearchParams) base.forEach((v, k) => params.append(k, v));
      else if (base) for (const [k, v] of Object.entries(base)) for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) params.append(k, one);

      const savedValues = (field: ViewField) => filterValues(saved.filters, field);
      const currentValues = (field: ViewField) => filterValues(current.filters, field);
      const changed = (field: ViewField) => !sameSet(currentValues(field), savedValues(field));
      const joined = (values: readonly string[]) => values.map(esc).join(',');

      for (const field of BUILTIN_FIELDS) {
        const name = LIST_PARAMS[field];
        if (name && changed(field)) params.set(name, joined(currentValues(field)));
      }
      const status = parseExplorerStatus(currentValues('status')[0]);
      if (status !== parseExplorerStatus(savedValues('status')[0])) params.set('status', status);
      for (const field of GENERIC_FIELDS) {
        if (changed(field)) params.append('f', `${field}=${currentValues(field).map(esc).join('|')}`);
      }

      if (!sameWindow(current.window, saved.window)) {
        if (current.window.mode === 'custom') {
          params.set('from', current.window.from);
          params.set('to', current.window.to);
        } else {
          params.set('window', String(current.window.days));
        }
      }
      if (current.search !== saved.search) params.set('q', current.search);
      if (!sameList(current.columns, saved.columns)) params.set('cols', joined(current.columns));
      const sort = effectiveSort(current.sort);
      if (sort.field !== effectiveSort(saved.sort).field || sort.dir !== effectiveSort(saved.sort).dir) params.set('sort', `${sort.field}:${sort.dir}`);
      if (!sameList(current.groupBy, saved.groupBy)) params.set('group', joined(current.groupBy));
      if (current.groupSort.by !== saved.groupSort.by || current.groupSort.dir !== saved.groupSort.dir) {
        params.set('gsort', `${current.groupSort.by}:${current.groupSort.dir}`);
      }

      const paths = new Set([...current.filters, ...saved.filters].filter(isRowFilter).filter(isActiveRowFilter).map(f => f.field));
      for (const field of paths) {
        if (!changed(field)) continue;
        const values = currentValues(field);
        params.append('rf', values.length > 0 ? `${esc(rowPath(field as RowField))}=${values.map(esc).join('|')}` : esc(rowPath(field as RowField)));
      }
      if (current.page > 1) params.set('page', String(current.page));
      return params;
    },
  };
}
