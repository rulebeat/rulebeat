'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { GridLayout, useContainerWidth } from 'react-grid-layout';
import type { LayoutItem, Layout as RGLLayoutArray } from 'react-grid-layout';
import {
  Pencil, Plus, RefreshCw, Clock, Trash2, Copy,
  ChevronDown, Save, MoreHorizontal, Star,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { WidgetWrapper } from '@/components/dashboard/widget-wrapper';
import { WidgetConfigPanel } from '@/components/dashboard/widget-config-panel';
import { AddWidgetPanel } from '@/components/dashboard/add-widget-panel';
import { StatCardWidget } from '@/components/dashboard/widgets/stat-card-widget';
import { PostureRingWidget } from '@/components/dashboard/widgets/posture-ring-widget';
import { TrendWidget } from '@/components/dashboard/widgets/trend-widget';
import { TopRulesWidget } from '@/components/dashboard/widgets/top-rules-widget';
import { CategoryScorecardWidget } from '@/components/dashboard/widgets/category-scorecard-widget';
import { RecentFindingsWidget } from '@/components/dashboard/widgets/recent-findings-widget';
import { SeverityBreakdownWidget } from '@/components/dashboard/widgets/severity-breakdown-widget';
import { SubscriptionScorecardWidget } from '@/components/dashboard/widgets/subscription-scorecard-widget';
import { TopResourcesWidget } from '@/components/dashboard/widgets/top-resources-widget';
import { CoverageFreshnessWidget } from '@/components/dashboard/widgets/coverage-freshness-widget';
import { NewVsFixedWidget } from '@/components/dashboard/widgets/new-vs-fixed-widget';
import { ActivityOccurrencesWidget } from '@/components/dashboard/widgets/activity-occurrences-widget';
import { DashboardFilterBar, type DashboardFilters } from '@/components/dashboard/dashboard-filter-bar';
import { REFRESH_OPTIONS } from '@/components/dashboard/dashboard-constants';
import type { Dashboard, WidgetDef } from '@/lib/types';
import { widgetHasScopeOverrides, type WidgetFilters } from '@/lib/dashboard-filters';
import type { DateWindow } from '@/lib/date-window';
import { cn } from '@/lib/utils';

type RGLLayout = LayoutItem;

interface Props { dashboard: Dashboard }

/* The grid's own geometry. Named here because the fit-to-content pass has to run
   the conversion backwards, from a measured pixel height to a row span. */
const ROW_HEIGHT = 80;
const ROW_MARGIN = 8;

function filtersFromConfig(config: Dashboard['config']): DashboardFilters {
  return {
    categories: config.filters?.categories ?? [],
    subscriptions: config.filters?.subscriptions ?? [],
    resourceGroups: config.filters?.resourceGroups ?? [],
    tags: config.filters?.tags ?? [],
    severities: config.filters?.severities ?? [],
    ruleIds: config.filters?.ruleIds ?? [],
  };
}

function WidgetRenderer({ widget, filters, filtered, refreshKey, editMode, onRemove, onConfigure }: {
  widget: WidgetDef;
  filters: WidgetFilters;
  filtered: boolean;
  refreshKey: number;
  editMode: boolean;
  onRemove: () => void;
  onConfigure: () => void;
}) {
  const inner = (() => {
    switch (widget.type) {
      case 'stat-card':
        return <StatCardWidget config={widget.config as never} filters={filters} refreshKey={refreshKey} />;
      case 'posture-ring':
        return <PostureRingWidget config={widget.config as never} filters={filters} refreshKey={refreshKey} />;
      case 'trend':
        return <TrendWidget config={widget.config as never} filters={filters} refreshKey={refreshKey} />;
      case 'top-rules':
        return <TopRulesWidget config={widget.config as never} filters={filters} refreshKey={refreshKey} />;
      case 'category-scorecard':
        return <CategoryScorecardWidget config={widget.config as never} filters={filters} refreshKey={refreshKey} />;
      case 'recent-findings':
        return <RecentFindingsWidget config={widget.config as never} filters={filters} refreshKey={refreshKey} />;
      case 'severity-breakdown':
        return <SeverityBreakdownWidget config={widget.config as never} filters={filters} refreshKey={refreshKey} />;
      case 'subscription-scorecard':
        return <SubscriptionScorecardWidget config={widget.config as never} filters={filters} refreshKey={refreshKey} />;
      case 'top-resources':
        return <TopResourcesWidget config={widget.config as never} filters={filters} refreshKey={refreshKey} />;
      case 'coverage-freshness':
        return <CoverageFreshnessWidget config={widget.config as never} filters={filters} refreshKey={refreshKey} />;
      case 'new-vs-fixed':
        return <NewVsFixedWidget config={widget.config as never} filters={filters} refreshKey={refreshKey} />;
      case 'activity-occurrences':
        return <ActivityOccurrencesWidget config={widget.config as never} filters={filters} refreshKey={refreshKey} />;
      default:
        return <div className="flex h-full items-center justify-center text-sm text-ink-muted">Unknown widget</div>;
    }
  })();

  return (
    <WidgetWrapper widget={widget} editMode={editMode} filtered={filtered} onRemove={onRemove} onConfigure={onConfigure}>
      {inner}
    </WidgetWrapper>
  );
}

export function DashboardGridClient({ dashboard: initial }: Props) {
  const router = useRouter();
  const [dashboard, setDashboard] = useState<Dashboard>(initial);
  const [widgets, setWidgets] = useState<WidgetDef[]>(initial.config.widgets);
  const [editMode, setEditMode] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dashFilters, setDashFilters] = useState<DashboardFilters>(filtersFromConfig(initial.config));
  const [dateWindow, setDateWindow] = useState<DateWindow>(
    initial.config.dateWindow ?? { mode: 'relative', days: initial.config.windowDays ?? 7 },
  );
  const filters: WidgetFilters = { ...dashFilters, dateWindow };
  const hasActiveFilters = dashFilters.categories.length > 0 || dashFilters.subscriptions.length > 0
    || dashFilters.resourceGroups.length > 0 || dashFilters.tags.length > 0
    || dashFilters.severities.length > 0 || dashFilters.ruleIds.length > 0;
  const [refreshKey, setRefreshKey] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(dashboard.config.autoRefresh ?? 0);
  const [countdown, setCountdown] = useState(0);
  const [configuringWidget, setConfiguringWidget] = useState<WidgetDef | null>(null);
  const [addingWidget, setAddingWidget] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState(dashboard.name);
  const [titleError, setTitleError] = useState('');
  const [error, setError] = useState<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const widgetsRef = useRef(initial.config.widgets);
  const autoFitRef = useRef(false);

  /* Both toolbar menus used to be hand-rolled: local open state, a ref and a
     shared document mousedown listener. The shared menu owns all of that now,
     including keyboard navigation and staying inside the viewport. */
  useEffect(() => { widgetsRef.current = widgets; }, [widgets]);
  const { width: gridWidth, containerRef: gridContainerRef } = useContainerWidth({ initialWidth: 1200 });

  // Filter-bar persistence — deliberately independent of the widget-layout `dirty`/edit-mode Save
  // flow above: changing a filter bumps refreshKey immediately (all widgets refetch) and persists
  // to the server debounced, with no explicit "Save" required and regardless of `editMode`. Built
  // from `dashboard.config` (last-synced state), never the possibly-dirty `widgets` local state,
  // so a filter change can never silently persist an unsaved layout edit as a side effect.
  const filtersFirstRender = useRef(true);
  useEffect(() => {
    if (filtersFirstRender.current) { filtersFirstRender.current = false; return; }
    setRefreshKey(k => k + 1);
    const t = setTimeout(() => {
      fetch(`/api/dashboards/${dashboard.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { ...dashboard.config, filters: dashFilters, dateWindow, windowDays: undefined } }),
      })
        .then(res => res.ok ? res.json() as Promise<Dashboard> : null)
        .then(d => { if (d) setDashboard(d); });
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashFilters, dateWindow]);

  // Every widget below self-fetches from /api/widgets/summary (or its own route) keyed off
  // `refreshKey` — bumping it is the shared "refetch everything" signal for manual refresh and
  // auto-refresh alike, no dashboard-level fetch needed here anymore.
  const fetchData = useCallback(() => {
    setRefreshKey(k => k + 1);
  }, []);

  // Auto-refresh
  useEffect(() => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    // Synchronizing the countdown to an external timer (setInterval), not deriving render state —
    // legitimate effect setState.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!autoRefresh) { setCountdown(0); return; }
    setCountdown(autoRefresh);
    countdownRef.current = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { fetchData(); return autoRefresh; }
        return c - 1;
      });
    }, 1000);
    return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
  }, [autoRefresh, fetchData]);

  /* Fit a widget's height to what it actually renders.
     A list widget gets a fixed row span from the template, so a category scorecard
     holding four cards sat in a box tall enough for twelve and left a dead area
     below them. Widgets that mark their natural-height block with
     `data-widget-content` get measured here and their row span shrunk to fit.
     Only ever shrinks: anything taller than its box keeps its own scrollbar.
     Watches the DOM rather than running once, because every widget fetches its own
     data: at first paint they are all spinners and there is nothing to measure. The
     MutationObserver is the one that matters — it catches a widget swapping its
     spinner for content — and the ResizeObserver handles the window being resized. */
  useEffect(() => {
    const container = gridContainerRef.current as HTMLElement | null;
    if (!container || editMode) return; // in edit mode the heights are the user's to set

    let raf = 0;
    const ro = new ResizeObserver(() => schedule());

    const measure = () => {
      const current = widgetsRef.current;
      let changed = false;

      // Blocks appear as each widget's fetch resolves, so pick up any that are new
      // since the last pass — a content block that grows later still gets measured.
      container.querySelectorAll('[data-widget-content]').forEach(el => ro.observe(el));

      const next = current.map(w => {
        const block = container.querySelector<HTMLElement>(`[data-grid-item="${w.id}"] [data-widget-content]`);
        const item = block?.closest<HTMLElement>('[data-grid-item]');
        // The widget's own content region, not the block's immediate parent: some
        // widgets put a scroll region in between, and that region sizes itself to
        // the content, which would report no unused space at all.
        const box = item?.querySelector<HTMLElement>('[data-widget-body]');
        if (!block || !item || !box) return w;

        // Measure the unused space rather than the widget chrome, so this never has
        // to know how tall a widget header is.
        const slack = box.clientHeight - block.offsetHeight;
        if (slack <= ROW_MARGIN) return w; // content fills the box, or overflows it

        const neededPx = item.offsetHeight - slack;
        const rows = Math.max(2, Math.ceil((neededPx + ROW_MARGIN) / (ROW_HEIGHT + ROW_MARGIN)));
        if (rows >= w.h) return w;

        changed = true;
        return { ...w, h: rows };
      });

      if (!changed) return;
      /* Shrinking a widget makes the grid compact everything below it upward, and
         RGL reports that back through onLayoutChange with new positions. Left alone
         it reads as a drag and the dashboard shows "Save changes" to someone who
         only opened the page. The flag tells that handler to take the new positions
         without treating them as an edit; it clears on a timer rather than after the
         first callback because one fit can produce several. */
      autoFitRef.current = true;
      widgetsRef.current = next;
      setWidgets(next);
      setTimeout(() => { autoFitRef.current = false; }, 300);
    };

    const schedule = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };

    const mo = new MutationObserver(schedule);
    mo.observe(container, { childList: true, subtree: true });
    ro.observe(container);
    schedule();

    return () => { mo.disconnect(); ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgets, gridWidth, editMode, refreshKey]);

  // Layout change from drag/resize.
  // RGL v2 fires onLayoutChange on mount (and after each state update) with the compacted layout.
  // We compare against the current widget positions — only mark dirty when something actually moved.
  function onLayoutChange(layout: RGLLayoutArray) {
    const items = layout as RGLLayout[];
    const current = widgetsRef.current;

    const changed = items.some(item => {
      const w = current.find(w => w.id === item.i);
      return w && (w.x !== item.x || w.y !== item.y || w.w !== item.w || w.h !== item.h);
    });

    if (!changed) return; // positions identical — RGL internal re-fire, ignore

    const merged = current.map(w => {
      const l = items.find(i => i.i === w.id);
      return l ? { ...w, x: l.x, y: l.y, w: l.w, h: l.h } : w;
    });
    widgetsRef.current = merged;
    setWidgets(merged);
    if (autoFitRef.current) return; // the fit-to-content pass moved these, not a person
    setDirty(true);
  }

  // Save title rename only
  async function saveTitle(newName: string) {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === dashboard.name) { setEditingTitle(false); setTitleValue(dashboard.name); return; }
    const res = await fetch(`/api/dashboards/${dashboard.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    });
    if (res.ok) {
      const d = await res.json() as Dashboard;
      setDashboard(d);
      setTitleValue(d.name);
      setTitleError('');
      setEditingTitle(false);
      router.refresh(); // update server-rendered Header
    } else {
      const body = await res.json().catch(() => ({})) as { error?: string };
      setTitleError(body.error ?? 'Failed to rename.');
      titleInputRef.current?.focus();
    }
  }

  // Save layout + config to API
  async function save(updatedWidgets: WidgetDef[] = widgets, updatedAutoRefresh = autoRefresh, updatedName = titleValue) {
    setSaving(true);
    try {
      const res = await fetch(`/api/dashboards/${dashboard.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: updatedName,
          // Layout/title/auto-refresh saves must not clobber the filter bar's own config keys —
          // that persistence is independent (see the debounced effect above).
          config: { ...dashboard.config, autoRefresh: updatedAutoRefresh, widgets: updatedWidgets },
        }),
      });
      if (res.ok) {
        const d = await res.json() as Dashboard;
        setDashboard(d);
        setDirty(false);
      }
    } finally { setSaving(false); }
  }

  function addWidget(partial: Omit<WidgetDef, 'id' | 'x' | 'y'>) {
    const maxY = widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0);
    const id = crypto.randomUUID();
    const newWidget: WidgetDef = { ...partial, id, x: 0, y: maxY };
    const updated = [...widgets, newWidget];
    setWidgets(updated);
    setDirty(true);
  }

  function removeWidget(id: string) {
    const updated = widgets.filter(w => w.id !== id);
    setWidgets(updated);
    setDirty(true);
  }

  function updateWidget(updated: WidgetDef) {
    const next = widgets.map(w => w.id === updated.id ? updated : w);
    setWidgets(next);
    setDirty(true);
  }

  async function handleDuplicate() {
    const res = await fetch(`/api/dashboards/${dashboard.id}/duplicate`, { method: 'POST' });
    if (res.ok) {
      const copy = await res.json() as Dashboard;
      router.push(`/dashboards/${copy.id}`);
      router.refresh();
    }
  }

  async function handleSetDefault() {
    const res = await fetch(`/api/dashboards/${dashboard.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isDefault: true }),
    });
    if (res.ok) {
      const d = await res.json() as Dashboard;
      setDashboard(d);
      router.refresh(); // invalidate cached server data so sidebar / gallery update
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete "${dashboard.name}"? This cannot be undone.`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/dashboards/${dashboard.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? 'Failed to delete dashboard.');
        return;
      }
      // /dashboard resolves to whatever the new default is, falling back to the gallery
      // (/dashboards) once the table is empty.
      router.push('/dashboard');
      router.refresh(); // invalidate cached server data so sidebar / gallery update
    } catch {
      setError('Failed to delete dashboard.');
    }
  }

  function handleRefreshChange(val: number) {
    setAutoRefresh(val);
    save(widgets, val, titleValue);
  }

  const layout: RGLLayout[] = widgets.map(w => ({
    i: w.id, x: w.x, y: w.y, w: w.w, h: w.h, minW: 2, minH: 2,
  }));

  return (
    /* No height cap and no scroll container of its own. The app has exactly one
       scroll region (app/(app)/layout.tsx) and this page used to add a second one
       around the grid, which meant the wheel scrolled whichever of the two the
       pointer happened to be over — so scrolling stopped dead partway down and
       only resumed after moving the cursor off a widget. */
    <div className="flex flex-col">
      {/* Toolbar and filters pin together as one block. Separately, the filter bar
          would scroll away under a stuck toolbar. */}
      <div className="sticky top-0 z-20 bg-surface">
      <div className="flex shrink-0 items-center gap-3 border-b border-rule-strong bg-surface px-6 py-2.5">

        {/* The dashboard's name is already the page heading and the active tab directly above.
            A third copy here read as a mistake, so this slot is empty until Rename is chosen
            from the More menu, at which point the field opens in place. */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {editingTitle && (
            <>
              <input
                ref={titleInputRef}
                autoFocus
                aria-label="Dashboard name"
                value={titleValue}
                onChange={e => { setTitleValue(e.target.value); setTitleError(''); }}
                onBlur={() => saveTitle(titleValue)}
                onKeyDown={e => {
                  if (e.key === 'Enter') saveTitle(titleValue);
                  if (e.key === 'Escape') { setEditingTitle(false); setTitleValue(dashboard.name); setTitleError(''); }
                }}
                className="min-w-0 max-w-64 border-b-2 border-ink bg-transparent text-base font-semibold text-ink outline-none"
              />
              {titleError && <span className="truncate text-xs font-medium text-sev-critical">{titleError}</span>}
            </>
          )}
        </div>

        {/* Refresh indicator */}
        {autoRefresh > 0 && !editMode && (
          <span className="numeral-grid flex items-center gap-1.5 text-xs font-medium text-ink-2">
            <Clock className="size-3.5" />
            {countdown > 0 ? `${countdown}s` : 'refreshing…'}
          </span>
        )}

        {/* Auto-refresh selector */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm" className="gap-1.5">
                <RefreshCw className="size-3.5" />
                {autoRefresh === 0 ? 'Off' : REFRESH_OPTIONS.find(o => o.value === autoRefresh)?.label ?? `${autoRefresh}s`}
                <ChevronDown className="size-3" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-32">
            {REFRESH_OPTIONS.map(o => (
              <DropdownMenuItem
                key={o.value}
                onClick={() => handleRefreshChange(o.value)}
                className={cn(autoRefresh === o.value && 'font-semibold')}
              >
                {o.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Manual refresh */}
        <Button variant="outline" size="icon-sm" onClick={fetchData} title="Refresh now" aria-label="Refresh now">
          <RefreshCw className="size-3.5" />
        </Button>

        {/* Edit mode toggle */}
        {editMode ? (
          <>
            <Button size="sm" variant="outline" onClick={() => { setEditMode(false); setWidgets(dashboard.config.widgets); setDirty(false); }}>
              Cancel
            </Button>
            <Button size="sm" className="gap-1.5" onClick={() => { save(); setEditMode(false); }} disabled={saving}>
              <Save className="size-3.5" />
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setAddingWidget(true)}>
              <Plus className="size-3.5" />Add Widget
            </Button>
          </>
        ) : (
          <>
            {dirty && (
              <Button size="sm" className="gap-1.5" onClick={() => save()} disabled={saving}>
                <Save className="size-3.5" />
                {saving ? 'Saving…' : 'Save changes'}
              </Button>
            )}
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setEditMode(true)}>
              <Pencil className="size-3.5" />Edit
            </Button>
          </>
        )}

        {/* More menu */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="icon-sm" aria-label="More dashboard actions">
                <MoreHorizontal className="size-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => { setTitleValue(dashboard.name); setEditingTitle(true); }}>
              <Pencil />Rename
            </DropdownMenuItem>
            {!dashboard.isDefault && (
              <DropdownMenuItem onClick={handleSetDefault}>
                <Star />Set as default
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={handleDuplicate}>
              <Copy />Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={handleDelete}>
              <Trash2 />Delete dashboard
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Dashboard-level filter bar — persists independently of edit mode / layout Save */}
      <DashboardFilterBar
        filters={dashFilters}
        dateWindow={dateWindow}
        onFiltersChange={setDashFilters}
        onDateWindowChange={setDateWindow}
      />

      {/* Edit mode banner */}
      {editMode && (
        <div className="shrink-0 border-b border-rule-strong bg-surface-sunken px-6 py-2">
          <p className="text-xs font-medium text-ink">Edit mode: drag widgets to rearrange, resize from corners, configure with the gear icon</p>
        </div>
      )}
      </div>

      {error && <Callout tone="error" className="shrink-0 border-b border-rule-strong">{error}</Callout>}

      {/* Grid */}
      <div className="px-4 py-4" ref={gridContainerRef as React.RefObject<HTMLDivElement>}>
        {widgets.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-4 border border-dashed border-rule-strong">
            <p className="text-sm text-ink-muted">No widgets yet</p>
            <Button size="sm" className="gap-1.5" onClick={() => { setEditMode(true); setAddingWidget(true); }}>
              <Plus className="size-3.5" />Add your first widget
            </Button>
          </div>
        ) : (
          <GridLayout
            width={gridWidth}
            layout={layout as never}
            gridConfig={{ cols: 12, rowHeight: ROW_HEIGHT, margin: [ROW_MARGIN, ROW_MARGIN] as const, containerPadding: null, maxRows: Infinity }}
            dragConfig={{ enabled: editMode, handle: '.widget-drag-handle', bounded: false, cancel: '', threshold: 0 }}
            resizeConfig={{ enabled: editMode, handles: ['se', 'sw', 'ne', 'nw', 's', 'n', 'e', 'w'] as const }}
            onLayoutChange={onLayoutChange}
          >
            {widgets.map(w => (
              /* data-grid-item is how the fit-to-content pass ties a measured content
                 block back to the widget whose row span it should shrink. */
              <div key={w.id} data-grid-item={w.id}>
                <WidgetRenderer
                  widget={w}
                  filters={filters}
                  filtered={hasActiveFilters || widgetHasScopeOverrides(w.config)}
                  refreshKey={refreshKey}
                  editMode={editMode}
                  onRemove={() => removeWidget(w.id)}
                  onConfigure={() => setConfiguringWidget(w)}
                />
              </div>
            ))}
          </GridLayout>
        )}
      </div>

      {/* Panels */}
      {configuringWidget && (
        <WidgetConfigPanel
          widget={configuringWidget}
          onClose={() => setConfiguringWidget(null)}
          onSave={updated => { updateWidget(updated); setConfiguringWidget(null); }}
        />
      )}
      {addingWidget && (
        <AddWidgetPanel onAdd={addWidget} onClose={() => setAddingWidget(false)} />
      )}

    </div>
  );
}
