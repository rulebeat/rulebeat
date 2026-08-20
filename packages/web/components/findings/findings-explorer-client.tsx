'use client';

import { useState, useMemo, useCallback, useEffect, Fragment, type Dispatch, type SetStateAction } from 'react';
import { useRouter } from 'next/navigation';
import {
  Search, X, ChevronDown, ChevronLeft, ChevronRight, ArrowUp, ArrowDown, ChevronsUpDown,
  Eye, EyeOff, LayoutList, Rows3, Copy, Check, ExternalLink, Sparkles,
} from 'lucide-react';
import { splitLearnMore } from '@/lib/rule-description';
import { SeverityBadge } from '@/components/findings/severity-badge';
import { CategoryBadge } from '@/components/findings/category-badge';
import { ExportButton } from '@/components/findings/export-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ChecklistDropdown, ColumnFilterIcon } from '@/components/ui/checklist-dropdown';
import { CodeBlock } from '@/components/ui/code-block';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import { useResizableColumns, ColumnResizeHandle } from '@/lib/hooks/use-resizable-columns';
import { cn } from '@/lib/utils';
import { resolveDateWindow, dateWindowLabel, type DateWindow } from '@/lib/date-window';
import { toggleInSet } from '@/lib/toggle-set';
import { useSubscriptionNames } from '@/lib/hooks/use-subscription-names';
import type { Severity, Suppression } from '@/lib/types';
import type { ExplorerData, ExplorerFinding, FindingDisplayStatus } from '@/lib/explorer-data';
import { getRecencyStatus, isWithinRange, matchesExplorerFilters, type ExplorerFilterDim } from '@/lib/explorer-filters';

// ---- Types ----

type SortCol = 'resource' | 'rule' | 'category' | 'severity' | 'firstSeen';
type SortDir = 'asc' | 'desc';
type StatusFilterValue = 'open' | 'new' | 'active' | 'fixed' | 'all';
type ViewMode = 'resource' | 'rule';

interface FindingsExplorerClientProps {
  data: ExplorerData;
  suppressions?: Suppression[];
  initialFilters?: {
    categories?: string[]; status?: string; ruleId?: string;
    /** In page mode (mode='page'), every one of these is also synced back to the URL (see the
     *  URL-sync effect below) — the initializer and that effect must read/write the exact same
     *  param set, or a deep-link/click-through value gets silently stripped on first render. In
     *  widget mode they're just one-shot initial values from the dashboard filter bar. */
    subscriptions?: string[]; tags?: string[]; severities?: Severity[];
    resourceGroups?: string[]; locations?: string[]; windowDays?: number; from?: string; to?: string; search?: string;
  };
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
}

// ---- Constants ----

const SEV_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];
const PAGE_SIZE = 50;

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
// "new" if it first appeared within the window and hasn't been fixed since; "fixed" status itself
// is always all-time (browsing "what's been resolved, ever" is a different question from "what got
// resolved recently") — the window only gates the separate "Fixed (Nd)" activity stat below. The
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

const STATUS_FILTER_OPTIONS = [
  { value: 'open',   label: 'Open (active + new)' },
  { value: 'new',    label: 'New only' },
  { value: 'active', label: 'Ongoing only' },
  { value: 'fixed',  label: 'Fixed only' },
  { value: 'all',    label: 'All statuses' },
];

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

// Builds a sorted { value, label, count } list for a subscription/RG/location filter dropdown —
// counted from a pool that isn't narrowed by the other toolbar filters, so picking a severity (say)
// never makes a subscription option disappear from its own dropdown.
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

/** Display subject for a finding row: a state finding's resource name (falling back to the tail
 *  of its resourceId), or an activity finding's dimensionKey ("pattern") — there is no resource
 *  to name (spec 034). */
function subjectLabel(f: Pick<ExplorerFinding, 'resourceName' | 'resourceId' | 'dimensionKey'>): string {
  return f.resourceName || f.dimensionKey || f.resourceId?.split('/').pop() || '';
}

function getColValue(f: ExplorerFinding, col: SortCol): string {
  switch (col) {
    case 'resource':  return subjectLabel(f);
    case 'rule':      return f.policyName;
    case 'category':  return f.category;
    case 'severity':  return f.severity;
    case 'firstSeen': return f.firstSeenAt;
  }
}

// Grouping key for the per-column Excel-style filter — distinct from the raw sort value for
// firstSeen, which would otherwise produce one option per exact timestamp (effectively unique
// per finding) instead of one per day.
function getColFilterKey(f: ExplorerFinding, col: SortCol): string {
  return col === 'firstSeen' ? shortDate(f.firstSeenAt) : getColValue(f, col);
}

function SortIcon({ col, active, dir }: { col: SortCol; active: SortCol; dir: SortDir }) {
  if (active !== col) return <ChevronsUpDown className="size-3 shrink-0 text-ink-faint" />;
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
  finding, suppression, canSuppress, onSuppress, onUnsuppress,
}: {
  finding: ExplorerFinding;
  suppression?: Suppression;
  canSuppress: boolean;
  onSuppress: (finding: ExplorerFinding, reason: string, expiresAt?: string) => void;
  onUnsuppress: (id: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [expiry, setExpiry] = useState('');

  if (suppression) {
    // The reason and expiry stay visible to everyone — that a finding is suppressed, and why, is
    // information a viewer needs. Only removing it is gated.
    return (
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="label-grid mb-1.5">Suppressed</p>
          <p className="text-[13px] text-ink">{suppression.reason}</p>
          {suppression.expiresAt && (
            <p className="mt-0.5 text-xs text-ink-muted">Expires {new Date(suppression.expiresAt).toLocaleDateString()}</p>
          )}
        </div>
        {canSuppress && (
          <Button variant="outline" size="sm" className="shrink-0" onClick={e => { e.stopPropagation(); onUnsuppress(suppression.id); }}>
            Remove suppression
          </Button>
        )}
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
    </div>
  );
}

// ---- Main component ----

export function FindingsExplorerClient({
  data, suppressions: suppressionsProp, initialFilters, canSuppress, mode = 'page', lockedCategory, basePath = '/findings', extraParams, emptyHint,
}: FindingsExplorerClientProps) {
  const router = useRouter();

  // Filters
  const [categoryFilter, setCategoryFilter] = useState<Set<string>>(
    lockedCategory ? new Set([lockedCategory]) : new Set(initialFilters?.categories ?? []),
  );
  const [severityFilter, setSeverityFilter] = useState<Set<Severity>>(new Set(initialFilters?.severities ?? []));
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>((initialFilters?.status as StatusFilterValue) ?? 'open');
  const [policyFilter, setPolicyFilter] = useState<Set<string>>(
    new Set(initialFilters?.ruleId ? initialFilters.ruleId.split(',').filter(Boolean) : []),
  );
  const [subFilter, setSubFilter] = useState<Set<string>>(new Set(initialFilters?.subscriptions ?? []));
  const [rgFilter, setRgFilter] = useState<Set<string>>(new Set(initialFilters?.resourceGroups ?? []));
  const [locFilter, setLocFilter] = useState<Set<string>>(new Set(initialFilters?.locations ?? []));
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set(initialFilters?.tags ?? []));
  const [search, setSearch] = useState(initialFilters?.search ?? '');
  const [view, setView] = useState<ViewMode>('resource');
  const [showSuppressed, setShowSuppressed] = useState(false);
  const [dateWindow, setDateWindow] = useState<DateWindow>(
    initialFilters?.from && initialFilters?.to
      ? { mode: 'custom', from: initialFilters.from, to: initialFilters.to }
      : { mode: 'relative', days: initialFilters?.windowDays ?? 7 },
  );
  const { from: rangeFrom, to: rangeTo } = useMemo(() => resolveDateWindow(dateWindow), [dateWindow]);
  const windowLabel = dateWindowLabel(dateWindow);

  // Sort / pagination / expand
  const [sortCol, setSortCol] = useState<SortCol>('severity');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [expandedRules, setExpandedRules] = useState<Set<string>>(new Set());

  // Per-column Excel-style filters (funnel icon in each header) — separate from the global
  // toolbar filters above so a column filter can be cleared independently.
  const [colFilters, setColFilters] = useState<Partial<Record<SortCol, Set<string>>>>({});
  const toggleColFilter = useCallback((col: SortCol, value: string) => {
    setColFilters(prev => ({ ...prev, [col]: toggleInSet(prev[col] ?? new Set(), value) }));
    setPage(0);
  }, []);
  const clearColFilter = useCallback((col: SortCol) => {
    setColFilters(prev => { const next = { ...prev }; delete next[col]; return next; });
    setPage(0);
  }, []);

  const { widths: colWidths, startResize, isFlexible } = useResizableColumns<SortCol>(
    // Each header holds a label, a sort arrow, a filter funnel and a resize handle, so a column
    // sized to its widest *value* truncates its own name. These are sized to the header.
    { resource: 260, rule: 200, category: 110, severity: 120, firstSeen: 134 },
    { flexCol: 'resource' },
  );

  // Suppressions — self-managed so the widget (no prop) and the page (prop provided) both work
  const [suppressions, setSuppressions] = useState<Suppression[]>(suppressionsProp ?? []);
  useEffect(() => {
    if (suppressionsProp) return;
    fetch('/api/suppressions').then(r => r.ok ? r.json() : []).then(setSuppressions).catch(() => {});
  }, [suppressionsProp]);

  // Subscription id → display name, for labelling the Subscription filter.
  const subNames = useSubscriptionNames();

  const resetPage = useCallback(() => setPage(0), []);

  // URL sync (page mode only) — must write back every param the initializer above can read, or a
  // deep-link/click-through value survives one render then gets silently erased the moment this
  // effect first runs (router.replace rewrites the whole query string from current state).
  useEffect(() => {
    if (mode !== 'page') return;
    const params = new URLSearchParams(extraParams);
    if (!lockedCategory && categoryFilter.size > 0) params.set('category', [...categoryFilter].join(','));
    if (statusFilter !== 'open') params.set('status', statusFilter);
    if (policyFilter.size > 0) params.set('ruleId', [...policyFilter].join(','));
    if (severityFilter.size > 0) params.set('severity', [...severityFilter].join(','));
    if (subFilter.size > 0) params.set('subscription', [...subFilter].join(','));
    if (rgFilter.size > 0) params.set('rg', [...rgFilter].join(','));
    if (locFilter.size > 0) params.set('location', [...locFilter].join(','));
    if (tagFilter.size > 0) params.set('tags', [...tagFilter].join(','));
    if (dateWindow.mode === 'custom') {
      params.set('from', dateWindow.from);
      params.set('to', dateWindow.to);
    } else if (dateWindow.days !== 7) {
      params.set('window', String(dateWindow.days));
    }
    if (search !== '') params.set('q', search);
    const qs = params.toString();
    router.replace(`${basePath}${qs ? `?${qs}` : ''}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    mode, categoryFilter, statusFilter, policyFilter, severityFilter, subFilter, rgFilter, locFilter,
    tagFilter, JSON.stringify(dateWindow), search, lockedCategory, basePath, JSON.stringify(extraParams),
  ]);

  const suppressedFps = useMemo(() => new Set(
    suppressions.filter(s => !s.expiresAt || new Date(s.expiresAt) > new Date()).map(s => s.fingerprint),
  ), [suppressions]);
  const suppMap = useMemo(() => new Map(suppressions.map(s => [s.fingerprint, s])), [suppressions]);

  // Global filtering (category/severity/status/policy/search/suppressed visibility) — factored
  // out of the `filtered` memo so the per-column filter option lists (below), and the stats pool,
  // can reuse the exact same predicate minus whichever dimension(s) should stay unfiltered. The
  // predicate itself lives in lib/explorer-filters.ts so it's unit-testable outside a React render.
  const passesGlobalFilters = useCallback((f: ExplorerFinding, exclude?: Set<ExplorerFilterDim>) => matchesExplorerFilters(f, {
    showSuppressed, suppressedFingerprints: suppressedFps, categories: categoryFilter, severities: severityFilter,
    status: statusFilter, ruleIds: policyFilter, subscriptions: subFilter, resourceGroups: rgFilter,
    locations: locFilter, tags: tagFilter, search, rangeFrom, rangeTo,
  }, exclude), [showSuppressed, suppressedFps, categoryFilter, severityFilter, statusFilter, rangeFrom, rangeTo, policyFilter, subFilter, rgFilter, locFilter, tagFilter, search]);

  const passesColFilters = useCallback((f: ExplorerFinding, exclude?: SortCol) => {
    for (const col of Object.keys(colFilters) as SortCol[]) {
      if (col === exclude) continue;
      const vals = colFilters[col];
      if (vals && vals.size > 0 && !vals.has(getColFilterKey(f, col))) return false;
    }
    return true;
  }, [colFilters]);

  const filtered = useMemo<ExplorerFinding[]>(
    () => data.findings.filter(f => passesGlobalFilters(f) && passesColFilters(f)),
    [data.findings, passesGlobalFilters, passesColFilters],
  );

  // Column filter option lists — built from the pool filtered by everything EXCEPT that column's
  // own selection, so picking a value never makes the other options in the same dropdown vanish.
  const colOptions = useMemo(() => {
    const result = {} as Record<SortCol, { value: string; label: string; count: number }[]>;
    for (const col of RESIZABLE_COLS) {
      const pool = data.findings.filter(f => passesGlobalFilters(f) && passesColFilters(f, col));
      const counts = new Map<string, number>();
      for (const f of pool) {
        const key = getColFilterKey(f, col);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      result[col] = [...counts.entries()]
        .map(([value, count]) => ({
          value,
          count,
          label: col === 'category' ? (data.categories.find(c => c.id === value)?.label ?? value) : value,
        }))
        .sort((a, b) => col === 'firstSeen' ? b.value.localeCompare(a.value) : a.label.localeCompare(b.label));
    }
    return result;
  }, [data.findings, data.categories, passesGlobalFilters, passesColFilters]);

  const sorted = useMemo(() => [...filtered].sort((a, b) => {
    let cmp = 0;
    switch (sortCol) {
      case 'resource':  cmp = (a.resourceName || '').localeCompare(b.resourceName || ''); break;
      case 'rule':      cmp = a.policyName.localeCompare(b.policyName); break;
      case 'category':  cmp = a.category.localeCompare(b.category); break;
      case 'severity':  cmp = SEV_ORDER[a.severity] - SEV_ORDER[b.severity]; break;
      case 'firstSeen': cmp = a.firstSeenAt.localeCompare(b.firstSeenAt); break;
    }
    return sortDir === 'asc' ? cmp : -cmp;
  }), [filtered, sortCol, sortDir]);

  // Global stats — respects every active filter (subscription/RG/location/tags/rule/search/
  // category) except severity and status themselves, so the pills stay a meaningful, stable
  // reference point to toggle from rather than one severity/status selection zeroing out the rest.
  const statsPool = useMemo(
    () => data.findings.filter(f => passesGlobalFilters(f, new Set(['severity', 'status']))),
    [data.findings, passesGlobalFilters],
  );

  const stats = useMemo(() => {
    const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    let newCount = 0, activeCount = 0, recentlyFixedCount = 0;
    for (const f of statsPool) {
      const recency = getRecencyStatus(f, rangeFrom, rangeTo);
      if (recency !== 'fixed') counts[f.severity]++;
      if (recency === 'new') newCount++;
      else if (recency === 'active') activeCount++;
      else if (isWithinRange(f.resolvedAt, rangeFrom, rangeTo)) recentlyFixedCount++;
    }
    return { total: newCount + activeCount, counts, newCount, activeCount, recentlyFixedCount };
  }, [statsPool, rangeFrom, rangeTo]);

  const suppressedCount = useMemo(
    () => data.findings.filter(f => (categoryFilter.size === 0 || categoryFilter.has(f.category)) && suppressedFps.has(f.fingerprint)).length,
    [data.findings, categoryFilter, suppressedFps],
  );

  // Each dropdown's own option list is built from a pool that excludes that dropdown's own
  // dimension (in addition to severity/status) — otherwise picking a Resource Group would, for
  // instance, remove every other Resource Group from its own list the moment it's selected.
  const subOptions = useMemo(() => {
    const pool = data.findings.filter(f => passesGlobalFilters(f, new Set(['severity', 'status', 'subscription'])));
    return buildMetaOptions(pool, f => f.subscriptionId)
      .map(o => ({ ...o, label: subNames[o.value] ?? o.value }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [data.findings, passesGlobalFilters, subNames]);
  const rgOptions = useMemo(() => {
    const pool = data.findings.filter(f => passesGlobalFilters(f, new Set(['severity', 'status', 'resourceGroup'])));
    return buildMetaOptions(pool, f => f.resourceGroup);
  }, [data.findings, passesGlobalFilters]);
  const locOptions = useMemo(() => {
    const pool = data.findings.filter(f => passesGlobalFilters(f, new Set(['severity', 'status', 'location'])));
    return buildMetaOptions(pool, f => f.location);
  }, [data.findings, passesGlobalFilters]);
  const tagOptions = useMemo(() => {
    const pool = data.findings.filter(f => passesGlobalFilters(f, new Set(['severity', 'status', 'tags'])));
    const counts = new Map<string, number>();
    for (const f of pool) for (const t of f.ruleTags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].map(([value, count]) => ({ value, label: value, count })).sort((a, b) => a.label.localeCompare(b.label));
  }, [data.findings, passesGlobalFilters]);

  // By-rule pivot
  const ruleRows = useMemo(() => {
    const map = new Map<string, {
      ruleId: string; name: string; category: string; severity: Severity; disabled: boolean;
      active: number; new: number; fixed: number; findings: ExplorerFinding[];
    }>();
    for (const f of filtered) {
      let e = map.get(f.ruleId);
      if (!e) {
        e = { ruleId: f.ruleId, name: f.policyName, category: f.category, severity: f.severity, disabled: f.ruleDisabled, active: 0, new: 0, fixed: 0, findings: [] };
        map.set(f.ruleId, e);
      }
      const recency = getRecencyStatus(f, rangeFrom, rangeTo);
      if (recency === 'new') e.new++;
      else if (recency === 'active') e.active++;
      else e.fixed++;
      e.findings.push(f);
    }
    return [...map.values()].sort((a, b) => (b.active + b.new) - (a.active + a.new));
  }, [filtered, rangeFrom, rangeTo]);

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const paginated = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds(prev => toggleInSet(prev, id));
  }, []);
  const toggleExpandRule = useCallback((id: string) => {
    setExpandedRules(prev => toggleInSet(prev, id));
  }, []);
  const toggleSeverity = useCallback((sev: Severity) => {
    setSeverityFilter(prev => toggleInSet(prev, sev));
    resetPage();
  }, [resetPage]);
  const toggleSetFilter = useCallback((setter: Dispatch<SetStateAction<Set<string>>>, value: string) => {
    setter(prev => toggleInSet(prev, value));
    resetPage();
  }, [resetPage]);
  const handleSort = useCallback((col: SortCol) => {
    setSortCol(prev => {
      if (prev === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
      else setSortDir('asc');
      return col;
    });
    resetPage();
  }, [resetPage]);

  const colFiltersActive = Object.values(colFilters).some(s => (s?.size ?? 0) > 0);
  const hasActiveFilter = (!lockedCategory && categoryFilter.size > 0) || severityFilter.size > 0 || statusFilter !== 'open'
    || policyFilter.size > 0 || subFilter.size > 0 || rgFilter.size > 0 || locFilter.size > 0 || tagFilter.size > 0 || search !== '' || colFiltersActive;
  const clearFilters = useCallback(() => {
    setCategoryFilter(lockedCategory ? new Set([lockedCategory]) : new Set()); setSeverityFilter(new Set()); setStatusFilter('open');
    setPolicyFilter(new Set()); setSubFilter(new Set()); setRgFilter(new Set()); setLocFilter(new Set()); setTagFilter(new Set());
    setSearch(''); setColFilters({}); resetPage();
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
    if (next.size !== policyFilter.size) setPolicyFilter(next);
  }, [availablePolicyOptions, policyFilter]);

  async function handleSuppress(finding: ExplorerFinding, reason: string, expiresAt?: string) {
    const res = await fetch('/api/suppressions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fingerprint: finding.fingerprint, resourceId: finding.resourceId, reason, expiresAt }),
    });
    if (res.ok) {
      const s = await res.json() as Suppression;
      setSuppressions(prev => [...prev, s]);
    }
  }
  async function handleUnsuppress(id: string) {
    await fetch(`/api/suppressions/${id}`, { method: 'DELETE' });
    setSuppressions(prev => prev.filter(s => s.id !== id));
  }

  const resourceFlexible = isFlexible('resource');
  const resourceTrack = resourceFlexible ? `minmax(${colWidths.resource}px, 1fr)` : `${colWidths.resource}px`;
  const gridTemplate = `20px ${resourceTrack} ${colWidths.rule}px ${colWidths.category}px ${colWidths.severity}px ${colWidths.firstSeen}px 28px`;
  // While the Resource column is still flexing to fill the card (default state), the grid should
  // size to 100% of its container so 1fr has room to expand into — forcing max-content here would
  // shrink it back to content width, leaving the table looking squeezed to the left. Once the user
  // manually resizes Resource, every column is a fixed px and the row needs max-content again so
  // the existing horizontal scroll wrapper knows the true (possibly wider-than-viewport) content width.
  const rowMinWidth: string | undefined = resourceFlexible ? undefined : 'max-content';

  if (data.findings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center bg-surface py-16 text-center">
        <Search className="mb-4 size-7 text-ink-faint" />
        <h3 className="mb-1 font-heading text-base font-semibold text-ink">No findings yet</h3>
        <p className="max-w-xs text-sm text-ink-muted">{emptyHint ?? 'Run a scan in any category to populate findings here.'}</p>
      </div>
    );
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
      {/* One strip divided by hairlines rather than seven floating cards. The severity
          counts are not a colour rainbow: critical is the only one that gets the accent,
          and the rest step down in ink weight, which is how Grid encodes severity
          everywhere else. Seven equally loud pastel boxes told you nothing about which
          number to look at first. */}
      <div className="grid grid-cols-4 bg-surface lg:grid-cols-7">
        {([
          { key: 'open',     label: 'Open',                   value: stats.total,              valueCls: 'text-ink' },
          { key: 'critical', label: 'Critical',               value: stats.counts.critical,    valueCls: 'text-sev-critical' },
          { key: 'high',     label: 'High',                   value: stats.counts.high,        valueCls: 'text-sev-high' },
          { key: 'medium',   label: 'Medium',                 value: stats.counts.medium,      valueCls: 'text-sev-medium' },
          { key: 'low',      label: 'Low',                    value: stats.counts.low,         valueCls: 'text-sev-low' },
          { key: 'new',      label: `New (${windowLabel})`,   value: stats.newCount,           valueCls: 'text-sev-critical',
            title: `First seen within ${windowLabel} and not yet fixed` },
          { key: 'fixed',    label: `Fixed (${windowLabel})`, value: stats.recentlyFixedCount, valueCls: 'text-status-ok',
            title: `Resolved within ${windowLabel}. Click to browse every fixed finding, any time` },
        ]).map(s => {
          // Only two of the seven actually filter anything. The rest are readouts, so they
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
                if (s.key === 'new') setStatusFilter(v => v === 'new' ? 'open' : 'new');
                else if (s.key === 'fixed') setStatusFilter(v => v === 'fixed' ? 'open' : 'fixed');
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
            onClick={() => { setCategoryFilter(new Set()); resetPage(); }}
            className={cn(TAB_CLS, categoryFilter.size === 0 ? TAB_ON : TAB_OFF)}
          >
            All categories
          </button>
          {data.categories.map(cat => (
            <button
              key={cat.id}
              type="button"
              aria-pressed={categoryFilter.has(cat.id)}
              onClick={() => { setCategoryFilter(prev => toggleInSet(prev, cat.id)); resetPage(); }}
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

        {/* The severity filters sit flush as one segmented control rather than four separate
            buttons, so they read as a single choice. Selected is an ink fill: this is a filter,
            not an alert, and four red buttons would out-shout the findings themselves. */}
        <div className="flex shrink-0 items-center border border-rule-strong">
          {SEVERITIES.map((sev, i) => (
            <button
              key={sev}
              type="button"
              aria-pressed={severityFilter.has(sev)}
              onClick={() => toggleSeverity(sev)}
              className={cn(
                'h-9 px-3 text-xs font-medium capitalize transition-colors outline-none',
                'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                i > 0 && 'border-l border-rule-strong',
                severityFilter.has(sev)
                  ? 'bg-ink text-surface'
                  : 'bg-surface text-ink-2 hover:bg-surface-hover hover:text-ink',
              )}
            >
              {sev}
            </button>
          ))}
        </div>

        <Select
          className="w-44 shrink-0"
          aria-label="Status"
          value={statusFilter}
          onValueChange={v => { setStatusFilter(v as StatusFilterValue); resetPage(); }}
          options={STATUS_FILTER_OPTIONS}
        />

        <div className="h-6 w-px shrink-0 bg-border" />

        {view === 'resource' && (
          <ChecklistDropdown
            label="Rule"
            options={availablePolicyOptions.map(p => ({ value: p.id, label: p.name }))}
            selected={policyFilter}
            onToggle={v => toggleSetFilter(setPolicyFilter, v)}
            onClear={() => { setPolicyFilter(new Set()); resetPage(); }}
          />
        )}
        {tagOptions.length > 0 && (
          <ChecklistDropdown
            label="Tags"
            options={tagOptions}
            selected={tagFilter}
            onToggle={v => toggleSetFilter(setTagFilter, v)}
            onClear={() => { setTagFilter(new Set()); resetPage(); }}
          />
        )}

        <div className="h-6 w-px bg-border shrink-0" />

        <ChecklistDropdown
          label="Subscription"
          options={subOptions}
          selected={subFilter}
          onToggle={v => toggleSetFilter(setSubFilter, v)}
          onClear={() => { setSubFilter(new Set()); resetPage(); }}
        />
        <ChecklistDropdown
          label="Resource Group"
          options={rgOptions}
          selected={rgFilter}
          onToggle={v => toggleSetFilter(setRgFilter, v)}
          onClear={() => { setRgFilter(new Set()); resetPage(); }}
        />
        <ChecklistDropdown
          label="Location"
          options={locOptions}
          selected={locFilter}
          onToggle={v => toggleSetFilter(setLocFilter, v)}
          onClear={() => { setLocFilter(new Set()); resetPage(); }}
        />

        {/* View toggle */}
        <div className="ml-auto flex h-9 items-center border border-rule-strong">
          <button
            type="button"
            aria-pressed={view === 'resource'}
            onClick={() => setView('resource')}
            className={cn(VIEW_TAB_CLS, view === 'resource' ? 'bg-ink text-surface' : VIEW_TAB_OFF)}
          >
            <Rows3 className="size-3.5" /> By resource
          </button>
          <button
            type="button"
            aria-pressed={view === 'rule'}
            onClick={() => setView('rule')}
            className={cn(VIEW_TAB_CLS, 'border-l border-rule-strong', view === 'rule' ? 'bg-ink text-surface' : VIEW_TAB_OFF)}
          >
            <LayoutList className="size-3.5" /> By rule
          </button>
        </div>

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

        <ExportButton findings={filtered} />
      </div>

      {view === 'rule' ? (
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
            <span className="label-grid text-right">Active</span>
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
                  <span className="text-right text-sm font-semibold tabular-nums text-ink">{r.active}</span>
                  <span className="text-right text-sm font-semibold tabular-nums text-sev-critical">{r.new || ''}</span>
                  <span className="text-right text-sm font-semibold tabular-nums text-status-ok">{r.fixed || ''}</span>
                </button>
                {isOpen && (
                  <div className="space-y-px px-8 pb-3">
                    <div className="flex justify-end pb-2">
                      <Button
                        variant="ghost" size="xs"
                        onClick={() => { setPolicyFilter(new Set([r.ruleId])); setView('resource'); resetPage(); }}
                      >
                        Filter to this rule
                      </Button>
                    </div>
                    {r.findings.map(f => {
                      const sCfg = STATUS_CFG[getRecencyStatus(f, rangeFrom, rangeTo)];
                      return (
                        <div key={f.fingerprint} className="flex items-center gap-3 px-3 py-1.5 text-xs hover:bg-surface-hover">
                          <span className={cn('size-1.5 shrink-0', sCfg.dot)} title={sCfg.label} />
                          <span className="min-w-0 flex-1 truncate text-ink">{subjectLabel(f)}</span>
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
              {sorted.length} {sorted.length === 1 ? 'finding' : 'findings'}
            </h3>
            {totalPages > 1 && (
              <div className="flex items-center gap-1.5">
                <span className="mr-1 text-xs tabular-nums text-ink-muted">Page {page + 1}/{totalPages}</span>
                <Button variant="outline" size="icon-xs" title="Previous page"
                  onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>
                  <ChevronLeft />
                </Button>
                <Button variant="outline" size="icon-xs" title="Next page"
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}>
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
                  onClick={() => handleSort(col)}
                  className={cn(
                    'flex min-w-0 items-center gap-1 transition-colors',
                    // Not `label-grid text-ink` — that utility sets its own colour and the two
                    // would tie on specificity. The strong variant is its own utility.
                    sortCol === col ? 'label-grid-strong' : 'label-grid hover:text-ink',
                  )}
                >
                  <span className="truncate">{COL_LABEL[col]}</span>
                  <SortIcon col={col} active={sortCol} dir={sortDir} />
                </button>
                <ColumnFilterIcon
                  label={COL_LABEL[col]}
                  options={colOptions[col]}
                  selected={colFilters[col] ?? new Set()}
                  onToggle={v => toggleColFilter(col, v)}
                  onClear={() => clearColFilter(col)}
                />
                <ColumnResizeHandle onMouseDown={startResize(col)} />
              </div>
            ))}
            <span />
          </div>

          {paginated.length === 0 ? (
            <div className="py-16 text-center text-sm text-ink-muted">No findings match your filters</div>
          ) : (
            <div style={{ minWidth: rowMinWidth }}>
              {paginated.map(f => {
                const isExpanded = expandedIds.has(f.fingerprint);
                const sCfg = STATUS_CFG[getRecencyStatus(f, rangeFrom, rangeTo)];
                const suppression = suppMap.get(f.fingerprint);

                return (
                  <div key={f.fingerprint} className={cn('border-b border-border last:border-0', isExpanded && 'bg-surface-sunken')}>
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      onClick={() => toggleExpand(f.fingerprint)}
                      className="group grid w-full items-center gap-x-4 px-5 py-3 text-left transition-colors hover:bg-surface-hover"
                      style={{ gridTemplateColumns: gridTemplate }}
                    >
                      <span className={cn('mx-auto mt-0.5 size-2 shrink-0', sCfg.dot)} title={sCfg.label} />

                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-ink">{subjectLabel(f)}</p>
                        <p className="truncate text-xs text-ink">{f.kind === 'activity' ? 'Activity pattern' : f.resourceType}</p>
                      </div>

                      <div className="flex min-w-0 items-center gap-1.5">
                        <p className="truncate text-xs text-ink" title={f.policyName}>{f.policyName}</p>
                        {f.ruleDisabled && <span className="label-grid shrink-0 border border-border bg-surface px-1 py-0.5">Off</span>}
                      </div>

                      <CategoryBadge id={f.category} categories={data.categories} />
                      <SeverityBadge severity={f.severity} />
                      <span className="text-xs tabular-nums text-ink-muted">{shortDate(f.firstSeenAt)}</span>

                      <span className="shrink-0 text-ink-faint transition-colors group-hover:text-ink-muted">
                        {isExpanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                      </span>
                    </button>

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
                                <PropertyCard label="Resource name" value={subjectLabel(f)} copyLabel="resource name" />
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

                        {/* Resource data — projected columns from the policy query. Mirrors the
                            same evidence rendering findings-table.tsx (Run History) uses, so a
                            finding shows the same detail regardless of which tab it's opened from. */}
                        {(() => {
                          const evidence = (f.evidence ?? {}) as Record<string, unknown>;
                          const isNew = '_rule' in evidence;
                          const ruleInfo = isNew
                            ? (evidence._rule as Record<string, unknown> | undefined)
                            : { field: evidence['field'], operator: evidence['operator'], value: evidence['value'], values: evidence['values'] };
                          const dataEntries = Object.entries(evidence).filter(([k]) =>
                            isNew ? k !== '_rule' : !['field', 'operator', 'value', 'values', 'presentTags'].includes(k)
                          );
                          if (dataEntries.length === 0 && !(ruleInfo && (ruleInfo['field'] || ruleInfo['operator']))) return null;
                          return (
                            <div className="space-y-4">
                              {dataEntries.length > 0 && (
                                <div>
                                  <p className="label-grid mb-2">Resource Data</p>
                                  <dl className="grid grid-cols-[auto_1fr] gap-x-8 gap-y-1.5">
                                    {dataEntries.map(([k, v]) => (
                                      <Fragment key={k}>
                                        <dt className="shrink-0 pt-0.5 font-mono text-xs text-ink-2">{k}</dt>
                                        <dd className="break-all font-mono text-xs text-ink">
                                          {typeof v === 'object' && v !== null
                                            ? <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(v, null, 2)}</pre>
                                            : String(v ?? '')}
                                        </dd>
                                      </Fragment>
                                    ))}
                                  </dl>
                                </div>
                              )}
                              {ruleInfo && Boolean(ruleInfo['field'] || ruleInfo['operator']) && (
                                <div>
                                  <p className="label-grid mb-1.5">Violated rule</p>
                                  <p className="font-mono text-xs text-ink">
                                    {String(ruleInfo['field'] ?? '')}
                                    {' '}
                                    <span className="text-ink">{String(ruleInfo['operator'] ?? '')}</span>
                                    {ruleInfo['value'] != null && <> <span className="font-medium text-ink">&apos;{String(ruleInfo['value'])}&apos;</span></>}
                                    {Array.isArray(ruleInfo['values']) && <> [{(ruleInfo['values'] as string[]).map(v => `'${v}'`).join(', ')}]</>}
                                  </p>
                                </div>
                              )}
                            </div>
                          );
                        })()}

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
                              onSuppress={handleSuppress}
                              onUnsuppress={handleUnsuppress}
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          </div>
        </div>
      )}

      {view === 'resource' && totalPages > 1 && (
        // The four controls sit flush as one bar rather than as separate floating
        // buttons, so the group reads as a single control with the page counter in it.
        <div className="flex items-center justify-center py-2">
          <div className="flex items-center border border-rule-strong">
            <Button variant="ghost" size="sm" className="h-8 rounded-none px-3"
              onClick={() => setPage(0)} disabled={page === 0}>First</Button>
            <Button variant="ghost" size="icon-sm" className="rounded-none border-l border-rule-strong" title="Previous page"
              onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>
              <ChevronLeft />
            </Button>
            <span className="numeral-grid border-x border-rule-strong px-4 py-1.5 text-xs text-ink-muted">
              Page {page + 1} of {totalPages}
            </span>
            <Button variant="ghost" size="icon-sm" className="rounded-none" title="Next page"
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}>
              <ChevronRight />
            </Button>
            <Button variant="ghost" size="sm" className="h-8 rounded-none border-l border-rule-strong px-3"
              onClick={() => setPage(totalPages - 1)} disabled={page >= totalPages - 1}>Last</Button>
          </div>
        </div>
      )}
    </div>
  );
}
