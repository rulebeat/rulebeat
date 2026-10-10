/**
 * What the view routes answer (ADR 0007), as one pure reference. Given every finding of a tab and a
 * View, `buildViewResponse` computes what the explorer computes in the browser today: the page of
 * findings, the grouped page, the header tiles, each filter's options, the by-rule rows, the
 * returned-column list and the hidden count. It is built only from the engine's own functions
 * (lib/finding-view.ts, lib/explorer-filters.ts), so it cannot drift from them. The server module
 * (lib/db/finding-views.ts) answers the same thing from the database without loading every finding's
 * rows, and the parity test holds the two equal. Client-safe: no Node, no database.
 *
 * The three secondary answers are the pages a first response leaves out: one finding's further rows,
 * one group's contents, and one returned column's values.
 */
import type { RuleKind } from './types';
import { resolveDateWindow } from './date-window';
import type { ExplorerFinding } from './explorer-data';
import type { FindingRecord } from './db/findings';
import { ACTIVITY_KINDS, ADVISORY_KINDS, KIND_LABEL, RESOLVABLE_KINDS, RESULTS_KINDS } from './finding-kinds';
import { ROWS_PER_PAGE, findingRows, pageFindingRows, type FindingRow } from './finding-rows';
import { countFindingsByRule, summarizeFindings, EXPLORER_SEVERITIES, type ExplorerStats, type RuleCounts } from './explorer-filters';
import {
  BUILTIN_FIELDS, DEFAULT_PAGE_SIZE, activeRowFilters, applyGroupedView, applyView, fieldOptions, filterFindings, isRowField, matchingRows,
  pageGroupItems, rowFieldOptions, rowPath,
  type BuiltinField, type RowField, type View, type ViewContext, type ViewField, type ViewFinding, type ViewGroup, type ViewItem,
} from './finding-view';

// ---- Tabs ----

/** The three listings that read the one findings table. */
export const VIEW_TABS = ['results', 'advisories', 'activity'] as const;
export type ViewTab = (typeof VIEW_TABS)[number];

/** Which kinds each tab lists: one kind each, so a finding is listed on exactly one tab. */
export const TAB_KINDS: Record<ViewTab, readonly RuleKind[]> = {
  results: RESULTS_KINDS, advisories: ADVISORY_KINDS, activity: ACTIVITY_KINDS,
};

/** A `tab` param read back, or null when it is none of the tabs. */
export function parseViewTab(value: string | null | undefined): ViewTab | null {
  return VIEW_TABS.find(tab => tab === value) ?? null;
}

/** The tab that lists a finding of this kind (an absent kind is 'state'). */
export function tabForKind(kind: RuleKind | undefined): ViewTab {
  return VIEW_TABS.find(tab => TAB_KINDS[tab].includes(kind ?? 'state')) ?? 'results';
}

/** What the header tiles count: the Advisories and Activity tabs their own kind, the Results tab
 *  what finding-level totals count (Problems), as the explorer passes them. */
export function tileKinds(tab: ViewTab): readonly RuleKind[] | undefined {
  return tab === 'results' ? undefined : TAB_KINDS[tab];
}

/** Whether a tab's findings can be Fixed. An Activity finding never resolves, so its tab offers no
 *  Fixed tile or status. */
export function tabResolves(tab: ViewTab): boolean {
  return TAB_KINDS[tab].some(kind => RESOLVABLE_KINDS.includes(kind));
}

/** The status choices a tab's explorer offers. New and Fixed carry the window in their label, like
 *  the header tiles they match; a tab whose findings never resolve offers no Fixed. */
export function tabStatusOptions(tab: ViewTab, windowLabel: string): { value: 'open' | 'new' | 'fixed' | 'all'; label: string }[] {
  return [
    { value: 'open', label: 'Open' },
    { value: 'new', label: `New (${windowLabel})` },
    ...(tabResolves(tab) ? [{ value: 'fixed' as const, label: `Fixed (${windowLabel})` }] : []),
    { value: 'all', label: 'All' },
  ];
}

// ---- Shapes ----

/** How many of a group's findings a response holds at once, and how many of a finding's rows. */
export const GROUP_ITEMS_PER_PAGE = DEFAULT_PAGE_SIZE;
export const ITEM_ROWS_PER_PAGE = ROWS_PER_PAGE;
/** How many values a returned column's option list holds. */
export const COLUMN_VALUES_LIMIT = 100;
/** The filters the header tiles leave out, so each tile can count what its own click would show. */
export const TILE_EXCLUDED_FIELDS: readonly ViewField[] = ['severity', 'status', 'resourceName', 'firstSeen'];
/** What the empty-value group is called. The engine only knows it as a null value. */
export const NO_VALUE_LABEL = 'No value';

/** What the response needs beyond the findings: the tab, the columns the rules in play have ever
 *  returned (the catalogue, which the reference cannot derive from rows it was not given), and the
 *  categories to name a group by. */
export interface ViewResponseOptions {
  tab: ViewTab;
  catalogueColumns: readonly string[];
  categories: ExplorerCategory[];
}

export interface ExplorerCategory { id: string; label: string; color?: string }

/** A finding as a response carries it: the explorer's finding, without its rows. */
export type ResponseFinding = Omit<ExplorerFinding, 'rows'>;

export interface ViewItemResponse {
  finding: ResponseFinding;
  /** The first page of the rows that match the view, in query order. */
  rows: FindingRow[];
  /** Every row the finding holds. */
  rowCount: number;
  /** The rows that match the view's row filters, which is every row when it has none. */
  matchedRowCount: number;
}

export interface GroupHeader {
  field: ViewField;
  /** Null is the empty-value group. */
  value: string | null;
  /** How the value reads on screen: a rule's name, a category's label. */
  label: string;
  resourceCount: number;
  rowCount: number;
}

export interface FacetOption { value: string; label: string; count: number }

export interface RuleRow {
  ruleId: string; name: string; category: string; severity: ExplorerFinding['severity']; disabled: boolean;
  open: number; new: number; fixed: number;
  /** Findings of the rule that match the view. */
  findingCount: number;
}

export interface ViewResponse {
  tab: ViewTab;
  kinds: readonly RuleKind[];
  /** Findings that match the view, across every page. */
  total: number;
  /** The page returned, 1-based and clamped into range: of findings, or of groups when grouped. */
  page: number;
  pageCount: number;
  pageSize: number;
  /** The page of findings. Empty when the view is grouped, whose page is `grouped.groups`. */
  items: ViewItemResponse[];
  grouped: { groups: GroupHeader[]; groupTotal: number; rowTotal: number; page: number; pageCount: number } | null;
  tiles: ExplorerStats;
  /** Each built-in field's values with how many findings hold them, counted with every filter but its
   *  own. Status has none: its options are Open, New, Fixed and All, not the stored values. */
  facets: Record<Exclude<BuiltinField, 'status'>, FacetOption[]>;
  ruleRows: RuleRow[];
  /** The returned columns on offer: those the rules in play have returned, and the picked ones. */
  columns: string[];
  /** Findings hidden by a suppression, within the category filter. */
  suppressedCount: number;
  lastScanAt?: string;
  policyOptions: { id: string; name: string; category: string }[];
  categories: ExplorerCategory[];
}

export interface FindingRowsResponse {
  fingerprint: string;
  rows: FindingRow[];
  page: number;
  pageCount: number;
  matchedRowCount: number;
  rowCount: number;
  /** The first returned row's position among the matched rows, for "Row n of total". */
  firstIndex: number;
}

export interface GroupResponse {
  /** The group asked for, or null when there is none at that path. */
  group: GroupHeader | null;
  /** The next level's groups. Empty at the last level. */
  groups: GroupHeader[];
  /** The group's findings, a page of them. Empty above the last level. */
  items: ViewItemResponse[];
  /** Findings in the group's own list, across every page. */
  total: number;
  page: number;
  pageCount: number;
}

export interface ColumnValuesResponse {
  column: RowField;
  /** At most `COLUMN_VALUES_LIMIT`, by how many findings hold each, most first. */
  values: { value: string; count: number }[];
  /** Values that match the search, before the cut. */
  total: number;
}

// ---- Building blocks ----

/** An explorer finding from a stored one and its rule: the rule's name (the finding's title when the
 *  rule is gone), whether it is disabled, and its tags. A copy of what `buildExplorerData` does, so
 *  the reference and the explorer name a finding alike. */
export function decorateFinding(
  record: FindingRecord,
  rule: RuleDetails | undefined,
): ExplorerFinding {
  const { evidence: _evidence, ...rest } = record;
  return { ...rest, ...ruleDecoration(record, rule) };
}

/** What a rule adds to a finding. Shared by the whole finding and by the slim one a server pass
 *  holds, so both are named alike. */
export function ruleDecoration(
  record: { title: string }, rule: RuleDetails | undefined,
): Pick<ExplorerFinding, 'policyName' | 'ruleDisabled' | 'ruleTags'> {
  return { policyName: rule?.name ?? record.title, ruleDisabled: rule ? !rule.enabled : false, ruleTags: rule?.tags ?? [] };
}

export interface RuleDetails { name: string; enabled: boolean; tags?: string[] }

/** The rules whose findings are listed, each once: the rules the catalogue is read for. */
export function rulesInPlay(findings: readonly { ruleId: string }[]): string[] {
  return [...new Set(findings.map(f => f.ruleId))];
}

/** What a value of a built-in field is called on screen. The browser names a subscription by its
 *  display name and a day by its date; the server knows neither, so both stay as stored. */
export function valueLabeler(
  findings: readonly Pick<ExplorerFinding, 'ruleId' | 'policyName'>[], categories: readonly ExplorerCategory[],
): (field: ViewField, value: string) => string {
  const ruleNames = new Map(findings.map(f => [f.ruleId, f.policyName] as const));
  const categoryLabels = new Map(categories.map(c => [c.id, c.label] as const));
  return (field, value) => {
    switch (field) {
      case 'rule': return ruleNames.get(value) ?? value;
      case 'category': return categoryLabels.get(value) ?? value;
      case 'kind': return KIND_LABEL[value as RuleKind] ?? value;
      default: return value;
    }
  };
}

export function groupHeader(
  group: Pick<ViewGroup<unknown>, 'field' | 'value' | 'resourceCount' | 'rowCount'>, label: (field: ViewField, value: string) => string,
): GroupHeader {
  return {
    field: group.field,
    value: group.value,
    label: group.value === null ? NO_VALUE_LABEL : isRowField(group.field) ? group.value : label(group.field, group.value),
    resourceCount: group.resourceCount,
    rowCount: group.rowCount,
  };
}

function itemResponse(item: ViewItem<ExplorerFinding>): ViewItemResponse {
  const { rows, ...finding } = item.finding;
  return { finding, rows: item.rows.slice(0, ITEM_ROWS_PER_PAGE), rowCount: findingRows({ rows }).length, matchedRowCount: item.rows.length };
}

/** The view's context with its window resolved to dates, once, so every part agrees on them. */
function resolved(view: View, ctx: ViewContext): ViewContext & { range: { from: string; to: string } } {
  return { ...ctx, range: ctx.range ?? resolveDateWindow(view.window) };
}

/** Every group of a view, with no paging at the top: the tree a group path is walked down. */
function wholeTree(findings: readonly ExplorerFinding[], view: View, ctx: ViewContext, label: (field: ViewField, value: string) => string) {
  return applyGroupedView(findings, { ...view, page: 1, pageSize: Number.MAX_SAFE_INTEGER }, ctx, { labelFor: label }).groups;
}

// ---- The responses ----

/** The first response for a view: everything a page of the explorer draws from the first read. */
export function buildViewResponse(
  findings: readonly ExplorerFinding[], view: View, rawCtx: ViewContext, opts: ViewResponseOptions,
): ViewResponse {
  const ctx = resolved(view, rawCtx);
  const { from, to } = ctx.range;
  const label = valueLabeler(findings, opts.categories);
  const pool = (except?: ViewField[]) => filterFindings(findings, view, ctx, { except: new Set(except) });

  const result = applyView(findings, view, ctx);
  const grouped = view.groupBy.length > 0 ? applyGroupedView(findings, view, ctx, { labelFor: label }) : null;

  return {
    tab: opts.tab,
    kinds: TAB_KINDS[opts.tab],
    total: result.total,
    page: grouped?.page ?? result.page,
    pageCount: grouped?.pageCount ?? result.pageCount,
    pageSize: Math.max(1, Math.floor(view.pageSize) || DEFAULT_PAGE_SIZE),
    items: grouped ? [] : result.items.map(itemResponse),
    grouped: grouped && {
      groups: grouped.groups.map(g => groupHeader(g, label)),
      groupTotal: grouped.groupTotal, rowTotal: grouped.rowTotal, page: grouped.page, pageCount: grouped.pageCount,
    },
    tiles: summarizeFindings(pool([...TILE_EXCLUDED_FIELDS]), from, to, tileKinds(opts.tab)),
    facets: buildFacets(pool, label),
    ruleRows: buildRuleRows(result.matched.map(m => m.finding), countFindingsByRule(pool(['status']), from, to, tileKinds(opts.tab))),
    columns: columnsOf(opts.catalogueColumns, view),
    suppressedCount: suppressedCountOf(findings, view, ctx),
    lastScanAt: lastScanAtOf(findings),
    policyOptions: policyOptionsOf(findings),
    categories: opts.categories,
  };
}

// ---- The parts of a view response, shared with the server's own pass ----

/** Each built-in field's options, counted over the pool with that field's own filter lifted. */
export function buildFacets(
  pool: (except: ViewField[]) => readonly ViewFinding[], label: (field: ViewField, value: string) => string,
): ViewResponse['facets'] {
  const facets = {} as ViewResponse['facets'];
  for (const field of BUILTIN_FIELDS) {
    if (field === 'status') continue;
    const options = fieldOptions(pool([field]), field).map(o => ({ ...o, label: label(field, o.value) }));
    if (field === 'severity') options.sort((a, b) => EXPLORER_SEVERITIES.indexOf(a.value as never) - EXPLORER_SEVERITIES.indexOf(b.value as never));
    else if (field === 'firstSeen' || field === 'lastSeen') options.sort((a, b) => b.value.localeCompare(a.value));
    else options.sort((a, b) => a.label.localeCompare(b.label));
    facets[field] = options;
  }
  return facets;
}

type RuleRowSource = Pick<ExplorerFinding, 'ruleId' | 'policyName' | 'category' | 'severity' | 'ruleDisabled'>;

/** The by-rule pivot: a row per rule, in the order its first finding appears in `matched` (the
 *  view's own order), counted by `counts`, most open first and then most fixed. */
export function buildRuleRows(matched: readonly RuleRowSource[], counts: ReadonlyMap<string, RuleCounts>): RuleRow[] {
  const byRule = new Map<string, RuleRow>();
  for (const finding of matched) {
    const row = byRule.get(finding.ruleId);
    if (row) row.findingCount++;
    else {
      const c = counts.get(finding.ruleId) ?? { open: 0, new: 0, fixed: 0 };
      byRule.set(finding.ruleId, {
        ruleId: finding.ruleId, name: finding.policyName, category: finding.category, severity: finding.severity,
        disabled: finding.ruleDisabled, ...c, findingCount: 1,
      });
    }
  }
  return [...byRule.values()].sort((a, b) => b.open - a.open || b.fixed - a.fixed);
}

/** The rules of the findings, each once with the last finding's name, by name. */
export function policyOptionsOf(findings: readonly Pick<ExplorerFinding, 'ruleId' | 'policyName' | 'category'>[]): ViewResponse['policyOptions'] {
  return [...new Map(findings.map(f => [f.ruleId, { id: f.ruleId, name: f.policyName, category: f.category }])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Findings hidden by a suppression, within the category filter. */
export function suppressedCountOf(
  findings: readonly Pick<ExplorerFinding, 'category' | 'fingerprint'>[], view: View, ctx: ViewContext,
): number {
  const categoryFilter = new Set(view.filters.find(f => f.field === 'category')?.values ?? []);
  const suppressed = ctx.suppressedFingerprints ?? new Set<string>();
  return findings.filter(f => (categoryFilter.size === 0 || categoryFilter.has(f.category)) && suppressed.has(f.fingerprint)).length;
}

export function lastScanAtOf(findings: readonly Pick<ExplorerFinding, 'lastSeenAt'>[]): string | undefined {
  return findings.reduce<string | undefined>((max, f) => (!max || f.lastSeenAt > max ? f.lastSeenAt : max), undefined);
}

/** The returned columns on offer: the catalogue's and the picked ones, sorted. */
export function columnsOf(catalogueColumns: readonly string[], view: View): string[] {
  return [...new Set([...catalogueColumns, ...view.columns])].sort((a, b) => a.localeCompare(b));
}

/** One finding's rows that match the view's row filters, a page of 20, or null when the tab lists no
 *  such finding. The built-in filters are not applied: the finding was asked for by name. */
export function buildFindingRowsResponse(
  findings: readonly ExplorerFinding[], view: View, _ctx: ViewContext,
  opts: { tab: ViewTab; fingerprint: string; rowsPage: number },
): FindingRowsResponse | null {
  const finding = findings.find(f => f.fingerprint === opts.fingerprint);
  if (!finding) return null;
  const matched = matchingRows(finding, activeRowFilters(view.filters));
  const page = pageFindingRows(matched, opts.rowsPage, ITEM_ROWS_PER_PAGE);
  return {
    fingerprint: finding.fingerprint, rows: page.rows, page: page.page, pageCount: page.pageCount,
    matchedRowCount: page.total, rowCount: findingRows(finding).length, firstIndex: page.firstIndex,
  };
}

/** One group's contents. `groupPath` is the values from the outermost group down, one per level of
 *  the view's `groupBy` (null for the empty-value group). Above the last level that is the next
 *  level's headers; at the last level it is the findings, a page of 50, each with the rows that fell
 *  in the group. A path that leads to no group is an empty answer, as a page past the end is. */
export function buildGroupResponse(
  findings: readonly ExplorerFinding[], view: View, rawCtx: ViewContext,
  opts: ViewResponseOptions & { groupPath: readonly (string | null)[]; groupPage: number },
): GroupResponse {
  const ctx = resolved(view, rawCtx);
  const label = valueLabeler(findings, opts.categories);
  const none: GroupResponse = { group: null, groups: [], items: [], total: 0, page: 1, pageCount: 1 };
  if (opts.groupPath.length === 0 || opts.groupPath.length > view.groupBy.length) return none;

  let level = wholeTree(findings, view, ctx, label);
  let group: ViewGroup<ExplorerFinding> | undefined;
  for (const value of opts.groupPath) {
    group = level.find(g => g.value === value);
    if (!group) return none;
    level = group.groups;
  }
  const itemsPage = pageGroupItems(group!.items, opts.groupPage, GROUP_ITEMS_PER_PAGE);
  return {
    group: groupHeader(group!, label),
    groups: group!.groups.map(g => groupHeader(g, label)),
    items: itemsPage.items.map(itemResponse),
    total: itemsPage.total, page: itemsPage.page, pageCount: itemsPage.pageCount,
  };
}

/** The values one returned column holds, for its filter's option list: counted over the findings that
 *  pass every filter but the row filters, with the other row filters applied to the rows, so picking a
 *  value never hides the rest. The top 100 by how many findings hold each, optionally only those that
 *  contain `q`, ignoring case. */
export function buildColumnValuesResponse(
  findings: readonly ExplorerFinding[], view: View, rawCtx: ViewContext,
  opts: { tab: ViewTab; column: RowField; q?: string },
): ColumnValuesResponse {
  const ctx = resolved(view, rawCtx);
  const rowFilterFields = new Set(view.filters.filter(f => isRowField(f.field)).map(f => f.field));
  const pool = filterFindings(findings, view, ctx, { except: rowFilterFields });
  const needle = (opts.q ?? '').toLowerCase();
  const matching = rowFieldOptions(pool, view.filters, rowPath(opts.column))
    .filter(o => needle === '' || o.value.toLowerCase().includes(needle))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  return { column: opts.column, values: matching.slice(0, COLUMN_VALUES_LIMIT), total: matching.length };
}
