'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Search, X, ChevronDown, ChevronLeft, ChevronRight, ArrowUp, ArrowDown, ChevronsUpDown,
  Eye, EyeOff, LayoutList, Rows3, Copy, Check, ExternalLink, Sparkles,
} from 'lucide-react';
import { splitLearnMore } from '@/lib/rule-description';
import { SeverityBadge } from '@/components/findings/severity-badge';
import { CategoryBadge } from '@/components/findings/category-badge';
import { ExportButton } from '@/components/findings/export-button';
import { FindingRowsDetail } from '@/components/findings/finding-rows-detail';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Callout } from '@/components/ui/callout';
import { ChecklistDropdown, ColumnFilterIcon, type ChecklistOption } from '@/components/ui/checklist-dropdown';
import { CodeBlock } from '@/components/ui/code-block';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import { WidgetUnavailable } from '@/components/dashboard/widgets/widget-unavailable';
import { useResizableColumns, ColumnResizeHandle } from '@/lib/hooks/use-resizable-columns';
import { cn } from '@/lib/utils';
import { resolveDateWindow, dateWindowLabel, type DateWindow } from '@/lib/date-window';
import { toggleInSet } from '@/lib/toggle-set';
import { Segmented, type SegmentedOption } from '@/components/ui/segmented';
import { useSubscriptionNames } from '@/lib/hooks/use-subscription-names';
import {
  requestSuppress, requestUnsuppress, applySuppress, applyUnsuppress, applySuppressionsLoad, fetchSuppressionList,
} from '@/lib/suppression-actions';
import type { RuleKind, Severity, Suppression } from '@/lib/types';
import type { ExplorerData, ExplorerFinding, FindingDisplayStatus } from '@/lib/explorer-data';
import {
  getRecencyStatus, parseExplorerStatus, countFindingsByRule, summarizeFindings, EXPLORER_SEVERITIES,
  type ExplorerStatusFilter,
} from '@/lib/explorer-filters';
import {
  BUILTIN_FIELDS, DEFAULT_SORT, applyGroupedView, applyView, clearFilter, columnCell, emptyView, fieldOptions, filterFindings, filterValues,
  findingSubject, isRowField, isRowFilter, pageGroupItems, rowField, rowFieldOptions, rowLeafPaths, rowPath, toggleFilterValue, viewToSearchParams,
  type BuiltinField, type GroupSort, type View, type ViewContext, type ViewField, type ViewFilter, type ViewGroup, type ViewItem, type ViewSort,
} from '@/lib/finding-view';
import { AddFilter, FilterChips, type AddFilterField, type FilterChip } from '@/components/findings/add-filter';
import { GroupBy } from '@/components/findings/group-by';
import { FindingsPager } from '@/components/findings/findings-pager';
import type { FindingRow } from '@/lib/finding-rows';

// ---- Types ----

type SortCol = 'resource' | 'rule' | 'category' | 'severity' | 'firstSeen';
type StatusFilterValue = ExplorerStatusFilter;
type ViewMode = 'resource' | 'rule';

interface FindingsExplorerClientProps {
  data: ExplorerData;
  suppressions?: Suppression[];
  /** The view the page opens on: filters, search, window, picked columns, sort and page. In page
   *  mode (mode='page') all of it is synced back to the URL (see the URL-sync effect below), and
   *  `viewFromSearchParams` / `viewToSearchParams` in lib/finding-view.ts are the one reader and
   *  writer of that param set, so a deep link is never silently stripped on first render. In
   *  widget mode it is just a one-shot initial value. */
  initialView?: View;
  /** Whether the viewer may create or remove suppressions. An existing suppression's reason is
   *  shown either way — only the create/remove controls are gated. */
  canSuppress: boolean;
  mode?: 'page' | 'widget';
  /** When set, hides the internal category tab strip and pins filtering to this category —
   *  for embedding this table scoped to one category (e.g. a future single-category widget). */
  lockedCategory?: string;
  /** URL to sync filter state onto in page mode. Defaults to '/findings'. */
  basePath?: string;
  /** Extra query params to always preserve when syncing the URL (e.g. `{ tab: 'results' }`) —
   *  params owned by the parent page, not by this component. */
  extraParams?: Record<string, string>;
  /** Overrides the "no findings yet" empty-state copy — useful when embedded under a specific
   *  category so the hint can name that category instead of a generic message. */
  emptyHint?: string;
  /** Overrides the "No findings yet" empty-state title, for a tab that has its own reason to be empty. */
  emptyTitle?: string;
  /** Which kinds the header tiles and the By rule counts add up. Defaults to what finding-level
   *  totals count (Problems); the Advisories tab passes its own so its tiles add up to its own Open. */
  kinds?: readonly RuleKind[];
  /** Hides the By rule view, for a listing where the per-rule pivot would not add anything. */
  hideRuleView?: boolean;
}

// ---- Constants ----

/** The width of a column the viewer picked from what the rules returned. */
const RETURNED_COL_WIDTH = 180;
/** The built-in field each column header filters and sorts by. */
const COL_FIELD: Record<SortCol, BuiltinField> = {
  resource: 'resourceName', rule: 'rule', category: 'category', severity: 'severity', firstSeen: 'firstSeen',
};
/** How a built-in field is named in the Add filter list and on a filter chip. */
const FIELD_LABEL: Record<BuiltinField, string> = {
  rule: 'Rule', kind: 'Kind', category: 'Category', severity: 'Severity', status: 'Status',
  subscription: 'Subscription', resourceGroup: 'Resource Group', location: 'Location',
  resourceType: 'Resource type', resourceName: 'Resource', tags: 'Tags', firstSeen: 'First seen', lastSeen: 'Last seen',
};
const SEVERITY_OPTIONS: SegmentedOption<Severity>[] = EXPLORER_SEVERITIES.map(sev => ({ value: sev, label: sev }));

/** What the empty-value group is called. The engine only knows it as a null value. */
const NO_VALUE_LABEL = 'No value';
/** How far each nesting level indents a group header's content. */
const GROUP_INDENT_REM = 1.5;

/** The fields and values from the outermost group down to one group, in order; a null value is the
 *  empty-value group. */
type GroupPath = readonly (string | null)[];
/** The one place a group's open state and page are keyed. A JSON array of the path, so a value that
 *  holds any character still cannot run into its neighbour, and the same value under two parents is
 *  two keys. A finding row inside a group appends its fingerprint, so a finding listed under two
 *  groups opens independently in each. */
const groupStateKey = (path: GroupPath) => JSON.stringify(path);

const KIND_LABEL: Record<string, string> = { state: 'Problem', advisory: 'Advisory', activity: 'Activity' };
/** Status has its own select in the toolbar, so the Add filter list leaves it out. */
const ADD_FILTER_BUILTINS = BUILTIN_FIELDS.filter(f => f !== 'status');
/** The filters the chip row shows. Status is the toolbar select, and a locked category is the page's own. */
const NO_CHIP_FIELDS: readonly ViewField[] = ['status'];

/* Status is an outcome, so it uses the status tokens rather than severity's. The
 * three are genuinely different states and colour is the fastest way to tell them
 * apart in a dense list, but the values are deep and desaturated on purpose: a row
 * marked "ongoing" should not compete with a critical severity on the same line. */
/* Ongoing is what almost every finding is, so it gets no colour: an amber square on every row of
 * the busiest table in the product is a permanent block of colour, and a screen already full of
 * colour is one where the handful of rows that changed no longer stand out. Colour is spent on
 * the two states worth reacting to, appeared and resolved. */
const STATUS_CFG: Record<FindingDisplayStatus, { dot: string; chip: string; label: string }> = {
  new:    { dot: 'bg-sev-critical', chip: 'border-sev-critical/35 bg-sev-critical-soft text-sev-critical', label: 'New'     },
  active: { dot: 'bg-ink-faint',    chip: 'border-border bg-surface-sunken text-ink-2',                    label: 'Ongoing' },
  fixed:  { dot: 'bg-status-ok',    chip: 'border-status-ok/35 bg-status-ok-soft text-status-ok',          label: 'Fixed'   },
};

// "New"/"Fixed" are defined purely by elapsed real time — never by comparing to "the previous
// scan," which breaks down the moment a run only targets one rule/tag instead of a whole category
// (there's no single well-defined "previous scan" to compare against in that case). A finding is
// "new" if it first appeared within the window and hasn't been fixed since, and "fixed" (for the
// tile, the by-rule column and the status option alike) if it was resolved within the window.
// "Open" in the by-rule view is every open finding and ignores the window altogether. The
// window itself is a pure [from, to] timestamp-range check (see `isWithinRange`), so an arbitrary
// past custom range works identically to a rolling preset — neither this classification nor the
// "Fixed (Nd)" count needs the findings list itself to be anything other than current state.
// (isWithinRange/getRecencyStatus live in lib/explorer-filters.ts, alongside passesGlobalFilters'
// extracted predicate, so both are unit-testable without a React render.)

// ---- Helpers ----

function fmt(iso?: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}
function shortDate(iso?: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
// A day key (YYYY-MM-DD) as a date, read at noon so a time zone cannot move it to the next day.
function dayKeyLabel(key: string) {
  return shortDate(`${key}T12:00:00`);
}

// New and Fixed carry the window in their label, like the header tiles they match.
function statusFilterOptions(windowLabel: string) {
  return [
    { value: 'open',  label: 'Open' },
    { value: 'new',   label: `New (${windowLabel})` },
    { value: 'fixed', label: `Fixed (${windowLabel})` },
    { value: 'all',   label: 'All' },
  ];
}

// Tab styling, named once because the strip renders "All categories" separately from the
// mapped list and the two must not drift apart.
const TAB_CLS = 'shrink-0 -mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm transition-colors';
const TAB_ON  = 'border-ink font-medium text-ink';
const TAB_OFF = 'border-transparent text-ink-2 hover:text-ink';

const VIEW_TAB_CLS = 'flex h-full items-center gap-1.5 px-3 text-xs font-medium transition-colors outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';
const VIEW_TAB_OFF = 'bg-surface text-ink-2 hover:bg-surface-hover hover:text-ink';

const COL_LABEL: Record<SortCol, string> = {
  resource: 'Resource', rule: 'Rule', category: 'Category', severity: 'Severity', firstSeen: 'First seen',
};
const RESIZABLE_COLS: SortCol[] = ['resource', 'rule', 'category', 'severity', 'firstSeen'];

// Builds a sorted { value, label, count } list for a subscription/RG/location filter dropdown,
// counted from that dropdown's facetPool (every other filter applied, its own left out).
function buildMetaOptions(pool: ExplorerFinding[], getter: (f: ExplorerFinding) => string | undefined) {
  const counts = new Map<string, number>();
  for (const f of pool) {
    const v = getter(f);
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: value, count }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function SortIcon({ field, active, dir }: { field: ViewField; active: ViewField; dir: 'asc' | 'desc' }) {
  if (active !== field) return <ChevronsUpDown className="size-3 shrink-0 text-ink-faint" />;
  // The sorted column is marked in ink, not the accent. Sorting a table is not a
  // critical state, and red here would put a permanent alarm colour in the header.
  return dir === 'asc'
    ? <ArrowUp className="size-3 shrink-0 text-ink" />
    : <ArrowDown className="size-3 shrink-0 text-ink" />;
}

// Copy-to-clipboard button used on the Resource properties grid (resource name / resource ID) —
// the rule's own title + description already explain *why* a finding exists, so the expanded
// panel's job is just to surface consistent, actionable identity fields, not re-derive the
// rule's own per-query output.
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={e => {
        e.stopPropagation();
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      title={`Copy ${label}`}
      className="flex size-6 shrink-0 items-center justify-center text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
    >
      {copied ? <Check className="size-3.5 text-status-ok" /> : <Copy className="size-3.5" />}
    </button>
  );
}

/** One returned-column cell of the flat list. A URL is a link that opens in a new tab, an object or
 *  array is compact JSON, an empty value is an empty cell, and a finding with several distinct
 *  values in the column shows the first and how many more. */
function ReturnedCell({ rows, path }: { rows: readonly FindingRow[]; path: string }) {
  const { value, more } = columnCell(rows, path);
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs text-ink">
      {value.kind === 'empty' && <span className="sr-only">No value</span>}
      {value.kind === 'url' && (
        <a
          href={value.href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          title={value.href}
          className="min-w-0 truncate underline decoration-ink-faint underline-offset-2 hover:decoration-ink"
        >
          {value.text}
        </a>
      )}
      {value.kind === 'json' && <span className="min-w-0 truncate font-mono" title={value.text}>{value.text}</span>}
      {value.kind === 'text' && <span className="min-w-0 truncate" title={value.text}>{value.text}</span>}
      {more > 0 && <span className="shrink-0 text-ink-2">+{more} more</span>}
    </div>
  );
}

function PropertyCard({ label, value, mono, copyLabel }: { label: string; value?: string; mono?: boolean; copyLabel?: string }) {
  return (
    <div className="min-w-0 border border-border bg-surface-sunken px-3 py-2">
      <p className="label-grid truncate">{label}</p>
      <div className="mt-1 flex min-w-0 items-center gap-1">
        <p className={cn('min-w-0 flex-1 break-words text-sm font-medium text-ink', mono && 'font-mono text-xs')}>
          {value || '—'}
        </p>
        {copyLabel && value && <CopyButton value={value} label={copyLabel} />}
      </div>
    </div>
  );
}

// ---- Suppression form (inline, on expand) ----

function SuppressionPanel({
  finding, suppression, canSuppress, error, onSuppress, onUnsuppress,
}: {
  finding: ExplorerFinding;
  suppression?: Suppression;
  canSuppress: boolean;
  /** Set only when this finding's own last suppress/unsuppress request was refused — the server's
   *  own message when the route returns one, a stable fallback otherwise. Never a raw error. */
  error?: string;
  onSuppress: (finding: ExplorerFinding, reason: string, expiresAt?: string) => void;
  onUnsuppress: (finding: ExplorerFinding, id: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [expiry, setExpiry] = useState('');

  if (suppression) {
    // The reason and expiry stay visible to everyone — that a finding is suppressed, and why, is
    // information a viewer needs. Only removing it is gated.
    return (
      <div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="label-grid mb-1.5">Suppressed</p>
            <p className="text-[13px] text-ink">{suppression.reason}</p>
            {suppression.expiresAt && (
              <p className="mt-0.5 text-xs text-ink-muted">Expires {new Date(suppression.expiresAt).toLocaleDateString()}</p>
            )}
          </div>
          {canSuppress && (
            <Button variant="outline" size="sm" className="shrink-0" onClick={e => { e.stopPropagation(); onUnsuppress(finding, suppression.id); }}>
              Remove suppression
            </Button>
          )}
        </div>
        {error && <Callout tone="error" className="mt-2.5">{error}</Callout>}
      </div>
    );
  }

  return (
    <div>
      <p className="label-grid mb-2.5">Suppress this finding</p>
      <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
        <Input
          inputSize="sm"
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="Reason (e.g. accepted risk, false positive)"
          className="flex-1"
        />
        <Input
          inputSize="sm"
          type="date"
          value={expiry}
          onChange={e => setExpiry(e.target.value)}
          title="Expiry date (optional)"
          className="w-auto shrink-0"
        />
        <Button
          size="sm" variant="outline" className="shrink-0"
          disabled={!reason.trim()}
          onClick={() => { onSuppress(finding, reason.trim(), expiry || undefined); setReason(''); setExpiry(''); }}
        >
          Suppress
        </Button>
      </div>
      {error && <Callout tone="error" className="mt-2.5">{error}</Callout>}
    </div>
  );
}

// ---- Main component ----

export function FindingsExplorerClient({
  data, suppressions: suppressionsProp, initialView, canSuppress, mode = 'page', lockedCategory, basePath = '/findings', extraParams, emptyHint,
  emptyTitle, kinds, hideRuleView = false,
}: FindingsExplorerClientProps) {
  const router = useRouter();
  const [initial] = useState<View>(() => initialView ?? emptyView());

  // Every filter on this page is one entry in one list: the toolbar controls, the header funnels,
  // the category tabs and the Add filter control all read and write it, and it is the View's own
  // `filters`, so nothing the viewer can narrow by is missing from the URL. A locked category is
  // the page's own and replaces whatever the URL held for it.
  const [filters, setFilters] = useState<ViewFilter[]>(() => (
    lockedCategory ? [...clearFilter(initial.filters, 'category'), { field: 'category', values: [lockedCategory] }] : initial.filters
  ));
  const [search, setSearch] = useState(initial.search);
  const [layout, setLayout] = useState<ViewMode>('resource');
  const [showSuppressed, setShowSuppressed] = useState(false);
  const [dateWindow, setDateWindow] = useState<DateWindow>(initial.window);
  const { from: rangeFrom, to: rangeTo } = useMemo(() => resolveDateWindow(dateWindow), [dateWindow]);
  const windowLabel = dateWindowLabel(dateWindow);
  const statusOptions = useMemo(() => statusFilterOptions(windowLabel), [windowLabel]);

  const valueSets = useMemo(
    () => Object.fromEntries(BUILTIN_FIELDS.map(field => [field, new Set(filterValues(filters, field))])) as Record<BuiltinField, Set<string>>,
    [filters],
  );
  const categoryFilter = valueSets.category;
  const severityFilter = valueSets.severity as Set<Severity>;
  const policyFilter = valueSets.rule;
  const subFilter = valueSets.subscription;
  const rgFilter = valueSets.resourceGroup;
  const locFilter = valueSets.location;
  const tagFilter = valueSets.tags;
  const statusFilter: StatusFilterValue = parseExplorerStatus(filterValues(filters, 'status')[0]);
  const rowFilters = useMemo(() => filters.filter(isRowFilter), [filters]);

  // Columns the rules returned, picked by the viewer
  const [columns, setColumns] = useState<string[]>(initial.columns);

  // Sort / pagination / expand. A null sort is the default, severity most severe first, which is
  // how a link to the default view carries no sort param.
  const [sort, setSort] = useState<ViewSort | null>(initial.sort);
  const [page, setPage] = useState(Math.max(0, initial.page - 1));
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [expandedRules, setExpandedRules] = useState<Set<string>>(new Set());
  const activeSort = sort ?? DEFAULT_SORT;

  // Grouping is part of the view (and the URL). Which groups are open, and the page each open group
  // is on, are local: a link opens with every group closed.
  const [groupBy, setGroupBy] = useState<ViewField[]>(initial.groupBy);
  const [groupSort, setGroupSort] = useState<GroupSort>(initial.groupSort);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [groupPages, setGroupPages] = useState<Map<string, number>>(new Map());

  const resetPage = useCallback(() => setPage(0), []);
  const toggleValue = useCallback((field: ViewField, value: string) => {
    setFilters(prev => toggleFilterValue(prev, field, value));
    setPage(0);
  }, []);
  const clearField = useCallback((field: ViewField) => {
    setFilters(prev => clearFilter(prev, field));
    setPage(0);
  }, []);
  const setValues = useCallback((field: ViewField, values: string[]) => {
    setFilters(prev => {
      const others = clearFilter(prev, field);
      return values.length > 0 ? [...others, { field, values } as ViewFilter] : others;
    });
    setPage(0);
  }, []);
  const setStatus = useCallback((status: StatusFilterValue) => setValues('status', status === 'open' ? [] : [status]), [setValues]);

  const { widths: colWidths, startResize, isFlexible } = useResizableColumns<SortCol>(
    // Each header holds a label, a sort arrow, a filter funnel and a resize handle, so a column
    // sized to its widest *value* truncates its own name. These are sized to the header.
    { resource: 260, rule: 200, category: 110, severity: 120, firstSeen: 134 },
    { flexCol: 'resource' },
  );

  // Suppressions — self-managed so the widget (no prop) and the page (prop provided) both work.
  // A failed load sets `suppressionsFailed` rather than falling back to `[]`, so widget mode can
  // tell "couldn't load" apart from "no suppressions exist" (see applySuppressionsLoad).
  const [suppressions, setSuppressions] = useState<Suppression[]>(suppressionsProp ?? []);
  const [suppressionsFailed, setSuppressionsFailed] = useState(false);
  const [suppressionsRetryTick, setSuppressionsRetryTick] = useState(0);
  useEffect(() => {
    if (suppressionsProp) return;
    let cancelled = false;
    fetchSuppressionList().then(result => {
      if (cancelled) return;
      const next = applySuppressionsLoad(result);
      setSuppressions(next.suppressions);
      setSuppressionsFailed(next.failed);
    });
    return () => { cancelled = true; };
  }, [suppressionsProp, suppressionsRetryTick]);

  // Per-finding suppress/unsuppress failure, keyed by fingerprint so one row's refused request
  // doesn't show on every other row's panel.
  const [suppressionErrors, setSuppressionErrors] = useState<Map<string, string>>(new Map());

  // Subscription id → display name, for labelling the Subscription filter.
  const subNames = useSubscriptionNames();

  const suppressedFps = useMemo(() => new Set(
    suppressions.filter(s => !s.expiresAt || new Date(s.expiresAt) > new Date()).map(s => s.fingerprint),
  ), [suppressions]);
  const suppMap = useMemo(() => new Map(suppressions.map(s => [s.fingerprint, s])), [suppressions]);

  // The view the engine runs: every control on this page, as one View (lib/finding-view.ts). The
  // same engine serves the Advisories widget, so a view this page can express is one the widget can.
  // Counts, the stats pool and each dropdown's options all come from `filterFindings` with the
  // fields they leave out named in `except`, so they can never disagree with the table.
  const findingView = useMemo<View>(() => ({
    ...emptyView(),
    filters, search, window: dateWindow, columns, sort, groupBy, groupSort, page: page + 1,
  }), [filters, search, dateWindow, columns, sort, groupBy, groupSort, page]);
  const viewCtx = useMemo<ViewContext>(() => ({
    showSuppressed, suppressedFingerprints: suppressedFps, range: { from: rangeFrom, to: rangeTo },
  }), [showSuppressed, suppressedFps, rangeFrom, rangeTo]);
  const globalPool = useCallback(
    (except?: ViewField[]) => filterFindings(data.findings, findingView, viewCtx, { except: new Set(except) }),
    [data.findings, findingView, viewCtx],
  );

  const result = useMemo(() => applyView(data.findings, findingView, viewCtx), [data.findings, findingView, viewCtx]);
  const filtered = useMemo<ExplorerFinding[]>(() => result.matched.map(m => m.finding), [result.matched]);
  // What a filter value is called on screen: a rule by name, a category by label, a subscription by
  // its display name, a day as a date. The value itself, which the URL carries, stays the id.
  const ruleNames = useMemo(() => {
    const names = new Map(data.findings.map(f => [f.ruleId, f.policyName] as const));
    for (const p of data.policyOptions) names.set(p.id, p.name);
    return names;
  }, [data.findings, data.policyOptions]);
  const valueLabel = useCallback((field: ViewField, value: string): string => {
    switch (field) {
      case 'rule': return ruleNames.get(value) ?? value;
      case 'category': return data.categories.find(c => c.id === value)?.label ?? value;
      case 'subscription': return subNames[value] ?? value;
      case 'kind': return KIND_LABEL[value] ?? value;
      case 'firstSeen':
      case 'lastSeen': return dayKeyLabel(value);
      default: return value;
    }
  }, [ruleNames, data.categories, subNames]);
  // The grouped tree, only when the By resource list is grouped. Counts, tiles and the export stay
  // on `result`, so grouping never changes one of them. Groups sort by value as `valueLabel` names
  // them, the same function the headers are drawn with.
  const grouped = useMemo(
    () => (layout === 'resource' && groupBy.length > 0
      ? applyGroupedView(data.findings, findingView, viewCtx, { labelFor: valueLabel })
      : null),
    [layout, groupBy, data.findings, findingView, viewCtx, valueLabel],
  );
  const fieldLabel = useCallback((field: ViewField) => (isRowField(field) ? `${rowPath(field)} (returned)` : FIELD_LABEL[field]), []);

  // Option lists for a built-in field, counted from every filter except that field's own, so
  // picking a value never makes the other options in the same list vanish.
  const builtinOptions = useCallback((field: BuiltinField): ChecklistOption[] => {
    const options = fieldOptions(globalPool([field]), field).map(o => ({ ...o, label: valueLabel(field, o.value) }));
    if (field === 'severity') return options.sort((a, b) => EXPLORER_SEVERITIES.indexOf(a.value as Severity) - EXPLORER_SEVERITIES.indexOf(b.value as Severity));
    if (field === 'firstSeen' || field === 'lastSeen') return options.sort((a, b) => b.value.localeCompare(a.value));
    return options.sort((a, b) => a.label.localeCompare(b.label));
  }, [globalPool, valueLabel]);

  // Column filter option lists, one per header funnel.
  const colOptions = useMemo(() => {
    const options = {} as Record<SortCol, ChecklistOption[]>;
    for (const col of RESIZABLE_COLS) options[col] = builtinOptions(COL_FIELD[col]);
    return options;
  }, [builtinOptions]);

  // The returned columns on offer, and the values each one holds, come from the findings that pass
  // every filter except the ones on returned columns, so picking a value never hides the others.
  const rowPool = useMemo(
    () => globalPool(rowFilters.map(f => f.field)),
    [globalPool, rowFilters],
  );
  const columnChoices = useMemo(() => {
    const paths = new Set(rowLeafPaths(rowPool));
    for (const picked of columns) paths.add(picked);
    return [...paths].sort((a, b) => a.localeCompare(b)).map(path => ({ value: path, label: path }));
  }, [rowPool, columns]);
  const returnedOptions = useCallback(
    (path: string): ChecklistOption[] => rowFieldOptions(rowPool, filters, path).map(o => ({ value: o.value, label: o.value, count: o.count })),
    [rowPool, filters],
  );
  const returnedSelected = useCallback((path: string) => new Set(filterValues(filters, rowField(path))), [filters]);

  const addFilterFields = useMemo<AddFilterField[]>(() => [
    ...ADD_FILTER_BUILTINS.map(field => ({ field, label: FIELD_LABEL[field] })),
    ...columnChoices.map(c => ({ field: rowField(c.value), label: fieldLabel(rowField(c.value)) })),
  ], [columnChoices, fieldLabel]);
  const addFilterOptions = useCallback(
    (field: ViewField): ChecklistOption[] => (isRowField(field) ? returnedOptions(rowPath(field)) : builtinOptions(field)),
    [builtinOptions, returnedOptions],
  );
  const chips = useMemo<FilterChip[]>(() => filters
    .filter(f => !NO_CHIP_FIELDS.includes(f.field) && !(lockedCategory && f.field === 'category'))
    .flatMap(f => f.values.map(value => ({ field: f.field, value, fieldLabel: fieldLabel(f.field), valueLabel: isRowField(f.field) ? value : valueLabel(f.field, value) }))),
  [filters, lockedCategory, fieldLabel, valueLabel]);

  // Global stats — respects every active filter (subscription/RG/location/tags/rule/search/
  // category) except severity and status themselves, so the pills stay a meaningful, stable
  // reference point to toggle from rather than one severity/status selection zeroing out the rest.
  // The Resource and First seen funnels pick single findings out, so they are left out as well.
  const statsPool = useMemo(() => globalPool(['severity', 'status', 'resourceName', 'firstSeen']), [globalPool]);

  const stats = useMemo(() => summarizeFindings(statsPool, rangeFrom, rangeTo, kinds), [statsPool, rangeFrom, rangeTo, kinds]);

  const suppressedCount = useMemo(
    () => data.findings.filter(f => (categoryFilter.size === 0 || categoryFilter.has(f.category)) && suppressedFps.has(f.fingerprint)).length,
    [data.findings, categoryFilter, suppressedFps],
  );

  // Each dropdown counts from every filter except its own, so its counts match the table, and
  // picking one Resource Group never removes the other Resource Groups from its list.
  const subOptions = useMemo(() => {
    return buildMetaOptions(globalPool(['subscription']), f => f.subscriptionId)
      .map(o => ({ ...o, label: subNames[o.value] ?? o.value }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [globalPool, subNames]);
  const rgOptions = useMemo(
    () => buildMetaOptions(globalPool(['resourceGroup']), f => f.resourceGroup),
    [globalPool],
  );
  const locOptions = useMemo(
    () => buildMetaOptions(globalPool(['location']), f => f.location),
    [globalPool],
  );
  const tagOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of globalPool(['tags'])) for (const t of f.ruleTags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].map(([value, count]) => ({ value, label: value, count })).sort((a, b) => a.label.localeCompare(b.label));
  }, [globalPool]);

  // By-rule pivot. The status filter decides which rules are listed and which findings expand
  // under each; the Open/New/Fixed numbers are counted with every filter except status, so a
  // rule's Open count is the same whatever window or status is picked.
  const ruleRows = useMemo(() => {
    const counts = countFindingsByRule(globalPool(['status']), rangeFrom, rangeTo, kinds);
    const map = new Map<string, {
      ruleId: string; name: string; category: string; severity: Severity; disabled: boolean;
      open: number; new: number; fixed: number; findings: ExplorerFinding[];
    }>();
    for (const f of filtered) {
      let e = map.get(f.ruleId);
      if (!e) {
        const c = counts.get(f.ruleId) ?? { open: 0, new: 0, fixed: 0 };
        e = { ruleId: f.ruleId, name: f.policyName, category: f.category, severity: f.severity, disabled: f.ruleDisabled, ...c, findings: [] };
        map.set(f.ruleId, e);
      }
      e.findings.push(f);
    }
    return [...map.values()].sort((a, b) => b.open - a.open || b.fixed - a.fixed);
  }, [filtered, globalPool, rangeFrom, rangeTo, kinds]);

  // Grouped, the page is a page of top-level groups; flat, a page of findings.
  const currentPage = grouped?.page ?? result.page;
  const totalPages = grouped?.pageCount ?? result.pageCount;
  const pageIndex = currentPage - 1;
  const paginated = result.items;

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds(prev => toggleInSet(prev, id));
  }, []);
  const toggleExpandRule = useCallback((id: string) => {
    setExpandedRules(prev => toggleInSet(prev, id));
  }, []);
  const handleSort = useCallback((field: ViewField) => {
    setSort(prev => {
      const current = prev ?? DEFAULT_SORT;
      const next: ViewSort = current.field === field
        ? { field, dir: current.dir === 'asc' ? 'desc' : 'asc' }
        : { field, dir: 'asc' };
      return next.field === DEFAULT_SORT.field && next.dir === DEFAULT_SORT.dir ? null : next;
    });
    resetPage();
  }, [resetPage]);
  // Picking a column adds it at the end, so columns read in the order they were chosen. Dropping one
  // takes its sort with it; a filter on it stays, as a chip.
  const toggleColumn = useCallback((path: string) => {
    if (columns.includes(path)) {
      setColumns(columns.filter(c => c !== path));
      setSort(prev => (prev?.field === rowField(path) ? null : prev));
    } else {
      setColumns([...columns, path]);
    }
    resetPage();
  }, [columns, resetPage]);

  // A new grouping starts from the first page with every group closed, since the old groups are gone.
  const changeGroupBy = useCallback((next: ViewField[]) => {
    setGroupBy(next);
    setExpandedGroups(new Set());
    setGroupPages(new Map());
    resetPage();
  }, [resetPage]);
  const changeGroupSort = useCallback((next: GroupSort) => {
    setGroupSort(next);
    resetPage();
  }, [resetPage]);
  const toggleGroup = useCallback((key: string) => setExpandedGroups(prev => toggleInSet(prev, key)), []);

  const hasActiveFilter = filters.some(f => f.values.length > 0 && !(lockedCategory && f.field === 'category')) || search !== '';
  const clearFilters = useCallback(() => {
    setFilters(lockedCategory ? [{ field: 'category', values: [lockedCategory] }] : []);
    setSearch(''); resetPage();
  }, [resetPage, lockedCategory]);

  // Scoped to whichever category is actually active — the locked prop (embedded/single-category
  // pages) or the interactive category tab (the "All Categories" strip). Previously only checked
  // lockedCategory, so clicking a category tab left the Rule dropdown listing every rule tenant-
  // wide instead of just the ones in view. With multi-select, the dropdown only narrows when
  // exactly one category is picked — two or more selected categories fall back to showing every
  // rule, since there's no single category left to scope the list to.
  const activeCategory = lockedCategory ?? (categoryFilter.size === 1 ? [...categoryFilter][0] : undefined);
  const availablePolicyOptions = useMemo(
    () => activeCategory ? data.policyOptions.filter(p => p.category === activeCategory) : data.policyOptions,
    [data.policyOptions, activeCategory],
  );

  // If the category changes out from under a selected rule (e.g. switching category tabs while
  // "Rule X" is pinned), drop whichever selected rules are no longer even listed in the dropdown
  // instead of silently filtering on them.
  useEffect(() => {
    if (policyFilter.size === 0) return;
    const validIds = new Set(availablePolicyOptions.map(p => p.id));
    const next = new Set([...policyFilter].filter(id => validIds.has(id)));
    // Pruning a selection made stale by an external category change, not deriving it from props —
    // legitimate effect setState.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (next.size !== policyFilter.size) setValues('rule', [...next]);
  }, [availablePolicyOptions, policyFilter, setValues]);

  // URL sync (page mode only). `viewToSearchParams` is the one writer of every param
  // `viewFromSearchParams` reads, so a deep link survives the first render instead of being erased
  // when router.replace rewrites the whole query string from current state. A locked category is
  // the page's own, not the viewer's, so it is not written.
  const urlQuery = useMemo(() => {
    const urlView: View = {
      ...findingView,
      filters: lockedCategory ? findingView.filters.filter(f => f.field !== 'category') : findingView.filters,
      page: currentPage,
    };
    return viewToSearchParams(urlView, extraParams).toString();
  }, [findingView, lockedCategory, currentPage, extraParams]);
  useEffect(() => {
    if (mode !== 'page') return;
    router.replace(`${basePath}${urlQuery ? `?${urlQuery}` : ''}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, urlQuery, basePath]);

  async function handleSuppress(finding: ExplorerFinding, reason: string, expiresAt?: string) {
    setSuppressionErrors(prev => { if (!prev.has(finding.fingerprint)) return prev; const next = new Map(prev); next.delete(finding.fingerprint); return next; });
    const outcome = await requestSuppress(finding, reason, expiresAt);
    if (outcome.ok) {
      setSuppressions(prev => applySuppress(prev, outcome));
    } else {
      setSuppressionErrors(prev => new Map(prev).set(finding.fingerprint, outcome.error));
    }
  }
  async function handleUnsuppress(finding: ExplorerFinding, id: string) {
    setSuppressionErrors(prev => { if (!prev.has(finding.fingerprint)) return prev; const next = new Map(prev); next.delete(finding.fingerprint); return next; });
    const outcome = await requestUnsuppress(id);
    setSuppressions(prev => applyUnsuppress(prev, outcome));
    if (!outcome.ok) setSuppressionErrors(prev => new Map(prev).set(finding.fingerprint, outcome.error));
  }

  const resourceFlexible = isFlexible('resource');
  const resourceTrack = resourceFlexible ? `minmax(${colWidths.resource}px, 1fr)` : `${colWidths.resource}px`;
  const gridTemplate = `20px ${resourceTrack} ${colWidths.rule}px ${colWidths.category}px ${colWidths.severity}px ${colWidths.firstSeen}px${columns.map(() => ` ${RETURNED_COL_WIDTH}px`).join('')} 28px`;
  // While the Resource column is still flexing to fill the card (default state), the grid should
  // size to 100% of its container so 1fr has room to expand into — forcing max-content here would
  // shrink it back to content width, leaving the table looking squeezed to the left. Once the user
  // manually resizes Resource, every column is a fixed px and the row needs max-content again so
  // the existing horizontal scroll wrapper knows the true (possibly wider-than-viewport) content width.
  const rowMinWidth: string | undefined = resourceFlexible ? undefined : 'max-content';

  // A failed suppressions load (widget mode only — page mode always gets the prop) must not look
  // like "no suppressions": every finding would briefly read as unsuppressed instead of showing
  // that the widget itself couldn't load. Checked ahead of the empty-findings state below, which
  // is a genuine "nothing to show" and would otherwise mask the real failure.
  if (mode === 'widget' && suppressionsFailed) {
    return <WidgetUnavailable onRetry={() => setSuppressionsRetryTick(t => t + 1)} />;
  }

  if (data.findings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center bg-surface py-16 text-center">
        <Search className="mb-4 size-7 text-ink-faint" />
        <h3 className="mb-1 font-heading text-base font-semibold text-ink">{emptyTitle ?? 'No findings yet'}</h3>
        <p className="max-w-xs text-sm text-ink-muted">{emptyHint ?? 'Run a scan in any category to populate findings here.'}</p>
      </div>
    );
  }

  // One finding as a row of the list, and its detail when expanded. The flat list and every expanded
  // group render through here, so a finding looks the same wherever it is listed. `expandKey` is what
  // its open or closed state is kept under: the fingerprint in the flat list, and one per group
  // inside a group, so opening a finding under one group leaves its other groups closed.
  const renderFinding = ({ finding: f, rows }: ViewItem<ExplorerFinding>, expandKey: string = f.fingerprint) => {
    const isExpanded = expandedIds.has(expandKey);
    const sCfg = STATUS_CFG[getRecencyStatus(f, rangeFrom, rangeTo)];
    const suppression = suppMap.get(f.fingerprint);

    return (
      <div key={f.fingerprint} className={cn('border-b border-border last:border-0', isExpanded && 'bg-surface-sunken')}>
        {/* A div, not a button: a returned column can hold a link, and a link may not sit
            inside a button. The click is a mouse convenience; the chevron at the end of
            the row is the real button that keyboards and screen readers use. */}
        <div
          onClick={() => toggleExpand(expandKey)}
          className="group grid w-full cursor-pointer items-center gap-x-4 px-5 py-3 text-left transition-colors hover:bg-surface-hover"
          style={{ gridTemplateColumns: gridTemplate }}
        >
          <span className={cn('mx-auto mt-0.5 size-2 shrink-0', sCfg.dot)} title={sCfg.label} />

          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-ink">{findingSubject(f)}</p>
            <p className="truncate text-xs text-ink">{f.kind === 'activity' ? 'Activity pattern' : f.resourceType}</p>
          </div>

          <div className="flex min-w-0 items-center gap-1.5">
            <p className="truncate text-xs text-ink" title={f.policyName}>{f.policyName}</p>
            {f.ruleDisabled && <span className="label-grid shrink-0 border border-border bg-surface px-1 py-0.5">Off</span>}
          </div>

          <CategoryBadge id={f.category} categories={data.categories} />
          <SeverityBadge severity={f.severity} />
          <span className="text-xs tabular-nums text-ink-muted">{shortDate(f.firstSeenAt)}</span>

          {columns.map(path => <ReturnedCell key={path} rows={rows} path={path} />)}

          <button
            type="button"
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${findingSubject(f)}`}
            onClick={e => { e.stopPropagation(); toggleExpand(expandKey); }}
            className="flex size-6 shrink-0 items-center justify-center text-ink-faint outline-none transition-colors hover:text-ink group-hover:text-ink-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          >
            {isExpanded ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}
          </button>
        </div>

        {isExpanded && (
          <div className="space-y-4 border-t border-border px-8 pb-5 pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn('inline-flex items-center gap-1.5 border px-2 py-1 text-xs font-medium', sCfg.chip)}>
                <span className={cn('size-1.5', sCfg.dot)} />
                {sCfg.label}
              </span>
              <span className="text-xs text-ink-muted">First seen {shortDate(f.firstSeenAt)} · Last seen {shortDate(f.lastSeenAt)} · Seen {f.timesSeen}×</span>
            </div>

            {/* The trailing "Learn more" URL on pack rules is split out and linked,
                never left as raw text in the description. */}
            {f.description && (() => {
              const { text, url } = splitLearnMore(f.description);
              return (
                <div>
                  <p className="text-sm text-ink-2">{text}</p>
                  {url && (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-flex items-center gap-1.5 text-[13px] font-medium text-ink underline decoration-ink-faint underline-offset-4 hover:decoration-ink"
                    >
                      Read the official guidance
                      <ExternalLink className="size-3.5" />
                    </a>
                  )}
                </div>
              );
            })()}

            <div className="space-y-2">
              <p className="label-grid mb-2">{f.kind === 'activity' ? 'Activity pattern' : 'Resource properties'}</p>
              {f.kind === 'activity' ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
                  <PropertyCard label="Pattern" value={f.dimensionKey} mono copyLabel="pattern" />
                  <PropertyCard label="Subscription" value={f.subscriptionId} />
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
                    <PropertyCard label="Resource name" value={findingSubject(f)} copyLabel="resource name" />
                    <PropertyCard label="Type" value={f.resourceType} />
                    <PropertyCard label="Resource Group" value={f.resourceGroup} />
                    <PropertyCard label="Subscription" value={f.subscriptionId} />
                    <PropertyCard label="Location" value={f.location} />
                  </div>
                  {/* Full-width row — the resource ID is always long, squeezing it into a
                      half-width grid cell forces a tall, hard-to-read wrap. */}
                  <PropertyCard label="Resource ID" value={f.resourceId} mono copyLabel="resource ID" />
                </>
              )}
            </div>

            {/* Resource data: projected columns from the policy query, one block per
                row. Run History (findings-table.tsx) renders the same component, so a
                finding shows the same rows whichever tab it's opened from. */}
            <FindingRowsDetail finding={{ evidence: rows[0] ?? f.evidence, rows }} />

            {/* Remediation is generated per rule, not authored per rule. Until that
                ships, say why the block is empty rather than hiding it. */}
            {!f.remediationSteps?.length && (
              <div>
                <p className="label-grid mb-2">Remediation</p>
                <div className="flex items-start gap-2.5 border border-dashed border-border bg-surface-sunken px-4 py-3">
                  <Sparkles className="mt-px size-4 shrink-0 text-ink-faint" />
                  <div>
                    <p className="text-[13px] font-medium text-ink">Guided fix coming soon</p>
                    <p className="mt-0.5 text-xs text-ink-muted">
                      RuleBeat will generate remediation for this finding from the rule that detected it, so it fits your resource rather than a generic template.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {f.remediationSteps?.length > 0 && (
              <div>
                <p className="label-grid mb-2">Remediation</p>
                {/* Shared code block, not a hand-built dark slate panel. The old one
                    was the same colour whatever the theme, so in light mode it was a
                    black card dropped into a white page and in dark mode it was the
                    only thing on screen darker than the page itself. */}
                <div className="space-y-2">
                  {f.remediationSteps.map((step, si) => (
                    <CodeBlock
                      key={si}
                      title={step.type}
                      actions={<span className="text-xs text-ink-muted">{step.title}</span>}
                      code={step.content.replace(/["']?<resource-id>["']?/g, `"${f.resourceId}"`)}
                    />
                  ))}
                </div>
              </div>
            )}

            {(canSuppress || suppression) && (
              <div className="border-t border-border pt-3">
                <SuppressionPanel
                  finding={f}
                  suppression={suppression}
                  canSuppress={canSuppress}
                  error={suppressionErrors.get(f.fingerprint)}
                  onSuppress={handleSuppress}
                  onUnsuppress={handleUnsuppress}
                />
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // The groups of a grouped list. A header is a real button that opens its group. An open group that
  // has child groups lists them one step further in; an open last-level group lists its findings,
  // 50 to a page with its own pager, so a retirement affecting 2,000 resources never renders 2,000
  // rows. Nesting indents the header's content only, so the findings underneath keep their cells
  // under the shared column header. `path` is the fields and values above, so the same value under
  // two parents is two groups.
  function renderGroups(groups: ViewGroup<ExplorerFinding>[], depth = 0, path: GroupPath = []): React.ReactNode {
    return groups.map(group => {
      const groupPath = [...path, group.field, group.value];
      const key = groupStateKey(groupPath);
      const isOpen = expandedGroups.has(key);
      const label = group.value === null ? NO_VALUE_LABEL : isRowField(group.field) ? group.value : valueLabel(group.field, group.value);
      const itemsPage = group.items.length > 0 ? pageGroupItems(group.items, groupPages.get(key) ?? 1) : null;
      return (
        <div key={key}>
          <button
            type="button"
            aria-expanded={isOpen}
            onClick={() => toggleGroup(key)}
            className="flex w-full items-center gap-3 border-b border-border px-5 py-3 text-left outline-none transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          >
            <span className="flex min-w-0 flex-1 items-center gap-3" style={{ paddingLeft: `${depth * GROUP_INDENT_REM}rem` }}>
              {isOpen ? <ChevronDown className="size-4 shrink-0 text-ink-faint" aria-hidden="true" /> : <ChevronRight className="size-4 shrink-0 text-ink-faint" aria-hidden="true" />}
              <span className={cn('min-w-0 flex-1 truncate text-sm font-medium', group.value === null ? 'text-ink-2' : 'text-ink')} title={label}>{label}</span>
            </span>
            <span className="shrink-0 text-xs tabular-nums text-ink-2">
              {group.resourceCount} {group.resourceCount === 1 ? 'resource' : 'resources'}, {group.rowCount} {group.rowCount === 1 ? 'row' : 'rows'}
            </span>
          </button>
          {isOpen && (
            <div>
              {group.groups.length > 0 && renderGroups(group.groups, depth + 1, groupPath)}
              {itemsPage && (
                <>
                  <div>
                    {itemsPage.items.map(item => renderFinding(item, groupStateKey([...groupPath, item.finding.fingerprint])))}
                  </div>
                  <FindingsPager
                    page={itemsPage.page}
                    pageCount={itemsPage.pageCount}
                    onPage={next => setGroupPages(prev => new Map(prev).set(key, next))}
                  />
                </>
              )}
            </div>
          )}
        </div>
      );
    });
  }

  return (
    <div className="space-y-5">

      {/* Scan context */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-ink-muted">
          {data.lastScanAt
            ? <><span className="font-medium text-ink">Last activity:</span> {fmt(data.lastScanAt)}</>
            : 'No scans yet'}
        </span>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-ink-2">
            New / Fixed window
            <DateRangePicker value={dateWindow} onChange={setDateWindow} />
          </label>
          {mode === 'widget' && (
            <a href="/findings" className="text-xs font-medium text-ink underline decoration-ink-faint underline-offset-4 hover:decoration-ink">Open Findings page</a>
          )}
        </div>
      </div>

      {/* Stats pills — New/Fixed are pure elapsed-time windows (firstSeenAt/resolvedAt vs. now),
          never "compared to the previous scan": that reference point breaks down the moment a run
          only targets a rule or tag instead of a whole category, since there's no single "previous
          scan" to diff against. A rolling window works identically no matter how the scan was
          scoped, and re-running the same scan seconds apart no longer swings the count to 0. */}
      {/* One strip divided by hairlines rather than eight floating cards. The severity
          counts are not a colour rainbow: critical is the only one that gets the accent,
          and the rest step down in ink weight, which is how Grid encodes severity
          everywhere else. Eight equally loud pastel boxes told you nothing about which
          number to look at first. The five severity tiles always add up to Open. */}
      <div className="grid grid-cols-4 bg-surface lg:grid-cols-8">
        {([
          { key: 'open',     label: 'Open',                   value: stats.total,              valueCls: 'text-ink' },
          { key: 'critical', label: 'Critical',               value: stats.counts.critical,    valueCls: 'text-sev-critical' },
          { key: 'high',     label: 'High',                   value: stats.counts.high,        valueCls: 'text-sev-high' },
          { key: 'medium',   label: 'Medium',                 value: stats.counts.medium,      valueCls: 'text-sev-medium' },
          { key: 'low',      label: 'Low',                    value: stats.counts.low,         valueCls: 'text-sev-low' },
          { key: 'info',     label: 'Info',                   value: stats.counts.info,        valueCls: 'text-ink-faint' },
          { key: 'new',     label: `New (${windowLabel})`,   value: stats.newCount,           valueCls: 'text-sev-critical',
            title: `First seen within ${windowLabel} and not yet fixed` },
          { key: 'fixed',    label: `Fixed (${windowLabel})`, value: stats.recentlyFixedCount, valueCls: 'text-status-ok',
            title: `Resolved within ${windowLabel}` },
        ]).map(s => {
          // Only two of the eight actually filter anything. The rest are readouts, so they
          // do not get a pointer or a hover state that promises a click will do something.
          const clickable = s.key === 'new' || s.key === 'fixed';
          const isOn = (s.key === 'new' && statusFilter === 'new') || (s.key === 'fixed' && statusFilter === 'fixed');
          return (
            <button
              key={s.key}
              type="button"
              title={s.title}
              aria-pressed={clickable ? isOn : undefined}
              disabled={!clickable}
              onClick={() => {
                if (s.key === 'new') setStatus(statusFilter === 'new' ? 'open' : 'new');
                else if (s.key === 'fixed') setStatus(statusFilter === 'fixed' ? 'open' : 'fixed');
                resetPage();
              }}
              className={cn(
                'relative px-4 py-3 text-left transition-colors',
                // Hairlines between cells only. The strip has no outline: it is a white panel
                // on the page ground, and its edge is where the white stops.
                'border-b border-r border-rule-faint last:border-r-0 lg:border-b-0',
                clickable ? 'cursor-pointer hover:bg-surface-hover' : 'cursor-default',
                isOn && 'bg-surface-sunken',
              )}
            >
              {isOn && <span aria-hidden="true" className="absolute inset-x-0 top-0 h-0.5 bg-ink" />}
              <div className={cn('numeral-grid mb-1.5 text-2xl', s.valueCls)}>{s.value}</div>
              <div className="label-grid truncate">{s.label}</div>
            </button>
          );
        })}
      </div>

      {/* Category tabs — hidden when embedded under a category-scoped page that already picks the category */}
      {!lockedCategory && (
        // The selected tab is marked in ink with a solid rule under it. It was the accent
        // red before, which put an alarm colour on the tab you were simply reading.
        <div className="scroll-x flex gap-0 border-b border-rule-strong">
          <button
            type="button"
            aria-pressed={categoryFilter.size === 0}
            onClick={() => clearField('category')}
            className={cn(TAB_CLS, categoryFilter.size === 0 ? TAB_ON : TAB_OFF)}
          >
            All categories
          </button>
          {data.categories.map(cat => (
            <button
              key={cat.id}
              type="button"
              aria-pressed={categoryFilter.has(cat.id)}
              onClick={() => toggleValue('category', cat.id)}
              className={cn(TAB_CLS, categoryFilter.has(cat.id) ? TAB_ON : TAB_OFF)}
            >
              {cat.label}
            </button>
          ))}
        </div>
      )}

      {/* Global filter bar — grouped by what the filter narrows: triage (severity/status),
          what-check (rule/tags), where (subscription/RG/location) — divided by thin separators
          so the growing filter count stays scannable instead of one undifferentiated row. */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative w-64 shrink-0">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint" />
          <Input
            value={search}
            onChange={e => { setSearch(e.target.value); resetPage(); }}
            placeholder="Search resource, rule, type…"
            aria-label="Search findings"
            className="pl-9"
          />
        </div>

        <div className="h-6 w-px shrink-0 bg-border" />

        {/* The severity filters sit flush as one segmented control rather than five separate
            buttons, so they read as a single choice. Selected is an ink fill: this is a filter,
            not an alert, and five red buttons would out-shout the findings themselves. */}
        <Segmented
          label="Severity"
          className="shrink-0"
          optionClassName="capitalize"
          options={SEVERITY_OPTIONS}
          isOn={sev => severityFilter.has(sev)}
          onSelect={sev => toggleValue('severity', sev)}
        />

        <Select
          className="w-44 shrink-0"
          aria-label="Status"
          value={statusFilter}
          onValueChange={v => setStatus(v as StatusFilterValue)}
          options={statusOptions}
        />

        <div className="h-6 w-px shrink-0 bg-border" />

        {layout === 'resource' && (
          <ChecklistDropdown
            label="Rule"
            options={availablePolicyOptions.map(p => ({ value: p.id, label: p.name }))}
            selected={policyFilter}
            onToggle={v => toggleValue('rule', v)}
            onClear={() => clearField('rule')}
          />
        )}
        {tagOptions.length > 0 && (
          <ChecklistDropdown
            label="Tags"
            options={tagOptions}
            selected={tagFilter}
            onToggle={v => toggleValue('tags', v)}
            onClear={() => clearField('tags')}
          />
        )}

        <div className="h-6 w-px bg-border shrink-0" />

        <ChecklistDropdown
          label="Subscription"
          options={subOptions}
          selected={subFilter}
          onToggle={v => toggleValue('subscription', v)}
          onClear={() => clearField('subscription')}
        />
        <ChecklistDropdown
          label="Resource Group"
          options={rgOptions}
          selected={rgFilter}
          onToggle={v => toggleValue('resourceGroup', v)}
          onClear={() => clearField('resourceGroup')}
        />
        <ChecklistDropdown
          label="Location"
          options={locOptions}
          selected={locFilter}
          onToggle={v => toggleValue('location', v)}
          onClear={() => clearField('location')}
        />

        <AddFilter
          fields={addFilterFields}
          optionsFor={addFilterOptions}
          selectedFor={field => new Set(filterValues(filters, field))}
          onToggle={toggleValue}
          onClear={clearField}
        />

        {layout === 'resource' && columnChoices.length > 0 && (
          <ChecklistDropdown
            label="Columns"
            options={columnChoices}
            selected={new Set(columns)}
            onToggle={toggleColumn}
            onClear={() => { setColumns([]); setSort(prev => (prev && isRowField(prev.field) ? null : prev)); resetPage(); }}
          />
        )}

        {layout === 'resource' && (
          <GroupBy
            fields={addFilterFields}
            groupBy={groupBy}
            groupSort={groupSort}
            fieldLabel={fieldLabel}
            onGroupBy={changeGroupBy}
            onGroupSort={changeGroupSort}
          />
        )}

        {/* View toggle */}
        {!hideRuleView && (
        <div className="ml-auto flex h-9 items-center border border-rule-strong">
          <button
            type="button"
            aria-pressed={layout === 'resource'}
            onClick={() => setLayout('resource')}
            className={cn(VIEW_TAB_CLS, layout === 'resource' ? 'bg-ink text-surface' : VIEW_TAB_OFF)}
          >
            <Rows3 className="size-3.5" /> By resource
          </button>
          <button
            type="button"
            aria-pressed={layout === 'rule'}
            onClick={() => setLayout('rule')}
            className={cn(VIEW_TAB_CLS, 'border-l border-rule-strong', layout === 'rule' ? 'bg-ink text-surface' : VIEW_TAB_OFF)}
          >
            <LayoutList className="size-3.5" /> By rule
          </button>
        </div>
        )}

        {suppressedCount > 0 && (
          <Button variant="outline" size="sm" onClick={() => setShowSuppressed(s => !s)}>
            {showSuppressed ? <EyeOff /> : <Eye />}
            {showSuppressed ? 'Hide' : 'Show'} suppressed ({suppressedCount})
          </Button>
        )}

        {hasActiveFilter && (
          <Button variant="outline" size="sm" onClick={clearFilters}>
            <X /> Clear
          </Button>
        )}

        <ExportButton findings={result.matched.map(({ finding, rows }) => ({ ...finding, rows, evidence: rows[0] ?? finding.evidence }))} />
      </div>

      <FilterChips chips={chips} onRemove={chip => toggleValue(chip.field, chip.value)} />

      {layout === 'rule' ? (
        /* ---- By-rule pivot ---- */
        /* No height cap. This was `max-h-[65vh]`, which put a second scrollbar inside the
           page's own and cut the table off at two thirds of the screen no matter how tall
           the screen was. The page scrolls instead, the same rule the table primitive
           follows. The header row is a consequence of that: it cannot also be sticky,
           because anything that scrolls sideways is a scroll container and `sticky` would
           bind to it rather than to the page. */
        <div className="bg-surface">
        <div className="scroll-x">
          <div className="grid gap-x-4 border-b border-rule-anchor px-5 py-2"
            style={{ gridTemplateColumns: '20px 1fr 110px 90px 70px 70px 70px' }}>
            <span />
            <span className="label-grid">Rule</span>
            <span className="label-grid">Category</span>
            <span className="label-grid">Severity</span>
            <span className="label-grid text-right">Open</span>
            <span className="label-grid text-right">New</span>
            <span className="label-grid text-right">Fixed</span>
          </div>
          {ruleRows.length === 0 ? (
            <div className="py-16 text-center text-sm text-ink-muted">No rules match your filters</div>
          ) : ruleRows.map(r => {
            const isOpen = expandedRules.has(r.ruleId);
            return (
              <div key={r.ruleId} className="border-b border-border last:border-0">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => toggleExpandRule(r.ruleId)}
                  className="grid w-full items-center gap-x-4 px-5 py-3 text-left transition-colors hover:bg-surface-hover"
                  style={{ gridTemplateColumns: '20px 1fr 110px 90px 70px 70px 70px' }}
                >
                  <span className="text-ink-faint">{isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</span>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">{r.name}</span>
                    {r.disabled && <span className="label-grid shrink-0 border border-border bg-surface-sunken px-1.5 py-0.5">Off</span>}
                  </span>
                  <CategoryBadge id={r.category} categories={data.categories} />
                  <SeverityBadge severity={r.severity} />
                  <span className="text-right text-sm font-semibold tabular-nums text-ink">{r.open}</span>
                  <span className="text-right text-sm font-semibold tabular-nums text-sev-critical">{r.new || ''}</span>
                  <span className="text-right text-sm font-semibold tabular-nums text-status-ok">{r.fixed || ''}</span>
                </button>
                {isOpen && (
                  <div className="space-y-px px-8 pb-3">
                    <div className="flex justify-end pb-2">
                      <Button
                        variant="ghost" size="xs"
                        onClick={() => { setValues('rule', [r.ruleId]); setLayout('resource'); }}
                      >
                        Filter to this rule
                      </Button>
                    </div>
                    {r.findings.map(f => {
                      const sCfg = STATUS_CFG[getRecencyStatus(f, rangeFrom, rangeTo)];
                      return (
                        <div key={f.fingerprint} className="flex items-center gap-3 px-3 py-1.5 text-xs hover:bg-surface-hover">
                          <span className={cn('size-1.5 shrink-0', sCfg.dot)} title={sCfg.label} />
                          <span className="min-w-0 flex-1 truncate text-ink">{findingSubject(f)}</span>
                          <span className="shrink-0 text-ink-muted">{shortDate(f.lastSeenAt)}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        </div>
      ) : (
        /* ---- By-resource flat table ---- */
        <div className="bg-surface">
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <h3 className="title-grid">
              {result.total} {result.total === 1 ? 'finding' : 'findings'}
            </h3>
            {totalPages > 1 && (
              <div className="flex items-center gap-1.5">
                <span className="mr-1 text-xs tabular-nums text-ink-muted">Page {pageIndex + 1}/{totalPages}</span>
                <Button variant="outline" size="icon-xs" title="Previous page"
                  onClick={() => setPage(Math.max(0, pageIndex - 1))} disabled={pageIndex === 0}>
                  <ChevronLeft />
                </Button>
                <Button variant="outline" size="icon-xs" title="Next page"
                  onClick={() => setPage(Math.min(totalPages - 1, pageIndex + 1))} disabled={pageIndex >= totalPages - 1}>
                  <ChevronRight />
                </Button>
              </div>
            )}
          </div>

          {/* Sideways only. The rows grow to their full height and the page scrolls, which is
              why the header row is no longer sticky — see the note on the by-rule table above. */}
          <div className="scroll-x">
          <div className="grid gap-x-4 border-b border-rule-anchor px-5 py-2" style={{ gridTemplateColumns: gridTemplate, minWidth: rowMinWidth }}>
            <span />
            {(['resource', 'rule', 'category', 'severity', 'firstSeen'] as SortCol[]).map(col => (
              <div key={col} className="relative flex items-center gap-1 min-w-0 pr-2">
                <button
                  type="button"
                  onClick={() => handleSort(COL_FIELD[col])}
                  className={cn(
                    'flex min-w-0 items-center gap-1 transition-colors',
                    // Not `label-grid text-ink` — that utility sets its own colour and the two
                    // would tie on specificity. The strong variant is its own utility.
                    activeSort.field === COL_FIELD[col] ? 'label-grid-strong' : 'label-grid hover:text-ink',
                  )}
                >
                  <span className="truncate">{COL_LABEL[col]}</span>
                  <SortIcon field={COL_FIELD[col]} active={activeSort.field} dir={activeSort.dir} />
                </button>
                <ColumnFilterIcon
                  label={COL_LABEL[col]}
                  options={colOptions[col]}
                  selected={valueSets[COL_FIELD[col]]}
                  onToggle={v => toggleValue(COL_FIELD[col], v)}
                  onClear={() => clearField(COL_FIELD[col])}
                />
                <ColumnResizeHandle onMouseDown={startResize(col)} />
              </div>
            ))}
            {columns.map(path => {
              const field = rowField(path);
              return (
                <div key={path} className="relative flex min-w-0 items-center gap-1 pr-2">
                  <button
                    type="button"
                    onClick={() => handleSort(field)}
                    title={path}
                    className={cn(
                      'flex min-w-0 items-center gap-1 transition-colors',
                      activeSort.field === field ? 'label-grid-strong' : 'label-grid hover:text-ink',
                    )}
                  >
                    <span className="truncate">{path}</span>
                    <SortIcon field={field} active={activeSort.field} dir={activeSort.dir} />
                  </button>
                  <ColumnFilterIcon
                    label={path}
                    options={returnedOptions(path)}
                    selected={returnedSelected(path)}
                    onToggle={v => toggleValue(field, v)}
                    onClear={() => clearField(field)}
                  />
                </div>
              );
            })}
            <span />
          </div>

          {(grouped ? grouped.groupTotal === 0 : paginated.length === 0) ? (
            <div className="py-16 text-center text-sm text-ink-muted">No findings match your filters</div>
          ) : (
            <div style={{ minWidth: rowMinWidth }}>
              {grouped ? renderGroups(grouped.groups) : paginated.map(item => renderFinding(item))}
            </div>
          )}
          </div>
        </div>
      )}

      {layout === 'resource' && <FindingsPager page={pageIndex + 1} pageCount={totalPages} onPage={next => setPage(next - 1)} />}
    </div>
  );
}
