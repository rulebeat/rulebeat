'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { GridLayout, useContainerWidth } from 'react-grid-layout';
import type { LayoutItem, Layout as RGLLayoutArray } from 'react-grid-layout';
import {
  Pencil, Plus, RefreshCw, Clock, Trash2, Copy,
  ChevronDown, Save, MoreHorizontal, Star, Lock,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { WidgetWrapper } from '@/components/dashboard/widget-wrapper';
import { WidgetRequestProvider } from '@/components/dashboard/widget-request';
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
import { AdvisoriesWidget } from '@/components/dashboard/widgets/advisories-widget';
import { DashboardFilterBar } from '@/components/dashboard/dashboard-filter-bar';
import { REFRESH_OPTIONS } from '@/components/dashboard/dashboard-constants';
import type { Dashboard, WidgetDef } from '@/lib/types';
import {
  widgetHasScopeOverrides, mergeWidgetFilters, savedFiltersOf, applyChanges, widgetFiltersOf, type WidgetFilters,
} from '@/lib/dashboard-filters';
import { dashboardAddress, type DashboardFilterChanges } from '@/lib/finding-view';
import { withWidgetOverrides, type DashboardBarState } from '@/lib/dashboard-bar';
import { NO_REFRESH_CHOICE, pageInterval, pickInterval, savedInterval, shownInterval, type RefreshChoice } from '@/lib/dashboard-refresh';
import { incomingDashboard, latestOf, noticeFor, revisionToSave, seeRevision } from '@/lib/dashboard-revision';
import { UNAVAILABLE_NOTICE, conflictNotice, movedDimensions } from '@/lib/dashboard-conflict';
import { sendFiltersSave, type SaveOutcome } from '@/lib/dashboard-filter-save-client';
import { widgetAccessReason, type OutsideAccess } from '@/lib/outside-access';
import { cn } from '@/lib/utils';

type RGLLayout = LayoutItem;

interface Props {
  dashboard: Dashboard;
  /** Subscription and resource group values, saved, in the address or on a widget, that the person's access does not reach. */
  outsideAccess: OutsideAccess;
  /** The filter bar for this person, worked out on the server from the address in the request. */
  bar: DashboardBarState;
  /** Whether the person may edit the dashboard, and why not. Edit mode previews widget drafts, which the server refuses without the right. */
  edit: { allowed: boolean; reason?: string };
  /** Whether the duplicate route will take this person's request. Computed on the server from the same action the route checks. */
  canDuplicate: boolean;
}

/* The grid's own geometry. Named here because the fit-to-content pass has to run
   the conversion backwards, from a measured pixel height to a row span. */
const ROW_HEIGHT = 80;
const ROW_MARGIN = 8;

function WidgetRenderer({ widget, stored, dashboardId, changes, filters, filtered, refreshKey, editMode, canPreview, outsideAccess, onRevision, onRemove, onConfigure }: {
  widget: WidgetDef;
  /** The widget as saved on the dashboard, or undefined for one added in this edit. */
  stored: WidgetDef | undefined;
  dashboardId: string;
  /** The filter changes in force, as query params. */
  changes: string;
  filters: WidgetFilters;
  filtered: boolean;
  refreshKey: number;
  editMode: boolean;
  /** The person has the edit right, so a draft widget may be counted by the server. */
  canPreview: boolean;
  outsideAccess: OutsideAccess;
  onRevision: (revision: number) => void;
  onRemove: () => void;
  onConfigure: () => void;
}) {
  // A widget filtered only to what the person cannot see says so, instead of drawing the zero its
  // empty read would turn into a 100% posture or "No violations found".
  const accessReason = widgetAccessReason(mergeWidgetFilters(filters, widget.config), outsideAccess);
  const inner = accessReason ? (
    <div role="status" className="flex h-full flex-col items-center justify-center gap-2 px-4 py-6 text-center">
      <Lock className="size-5 text-ink-2" aria-hidden="true" />
      <p className="text-sm font-semibold text-ink">{accessReason.title}</p>
      <p className="max-w-xs text-xs text-ink-2">{accessReason.detail}</p>
    </div>
  ) : (() => {
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
        return <NewVsFixedWidget config={widget.config as never} refreshKey={refreshKey} />;
      case 'activity-occurrences':
        return <ActivityOccurrencesWidget config={widget.config as never} refreshKey={refreshKey} />;
      case 'advisories':
        return <AdvisoriesWidget config={widget.config as never} filters={filters} refreshKey={refreshKey} />;
      default:
        return <div className="flex h-full items-center justify-center text-sm text-ink-muted">Unknown widget</div>;
    }
  })();

  // A widget edited in this session has a config the server has not saved, so the server counts the draft.
  // Only someone with the edit right can have one (Edit is off for the rest), and the server refuses the preview otherwise.
  const draft = canPreview && (!stored || JSON.stringify(stored.config) !== JSON.stringify(widget.config));

  return (
    <WidgetWrapper widget={widget} editMode={editMode} filtered={filtered} onRemove={onRemove} onConfigure={onConfigure}>
      <WidgetRequestProvider value={{ dashboardId, widgetId: widget.id, widgetType: widget.type, changes, onRevision, preview: draft ? { config: widget.config as Record<string, unknown> } : undefined }}>
        {inner}
      </WidgetRequestProvider>
    </WidgetWrapper>
  );
}

/** The layout a save sends. The saved filters and window are not part of it: the server keeps them. */
export function layoutConfig(config: Dashboard['config'], autoRefresh: number, widgets: WidgetDef[]): Dashboard['config'] {
  const { filters: _filters, dateWindow: _dateWindow, windowDays: _windowDays, ...rest } = config;
  return { ...rest, autoRefresh, widgets };
}

export function DashboardGridClient({ dashboard: initial, outsideAccess, bar, edit: editRight, canDuplicate }: Props) {
  const router = useRouter();
  // A save can find the edit right gone (a Role change or a handover while the page was open). The page then
  // shows the controls off with the reason the server gave, as it would for anyone who never had the right.
  const [lostEditReason, setLostEditReason] = useState<string | null>(null);
  const edit = lostEditReason ? { allowed: false, reason: lostEditReason } : editRight;
  // The dashboard was deleted, unshared or handed over while the page was open.
  const [unavailable, setUnavailable] = useState(false);
  // The notice a save that met a newer revision leaves. It outlasts the reload that follows, and it goes
  // when the address no longer holds changes to check.
  const [conflict, setConflict] = useState<string | null>(null);
  // The revision a conflict reported. While a layout edit is open the page keeps the dashboard it holds,
  // so a second Save goes over this one, not over the older revision of the layout.
  const [conflictRevision, setConflictRevision] = useState<number | undefined>(undefined);
  const [dashboard, setDashboard] = useState<Dashboard>(initial);
  const [widgets, setWidgets] = useState<WidgetDef[]>(initial.config.widgets);
  const [editMode, setEditMode] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // What the widgets ask the server for is the address: the changes on top of the saved filters. The
  // filter bar writes them there and nowhere else, so nothing a person picks is saved to the dashboard.
  const searchParams = useSearchParams();
  // The saved filters are the newest the server has sent, not the dashboard held for a layout edit: the
  // server counts with them, so the address is read against them too.
  const savedSource = latestOf(dashboard, initial);
  const saved = useMemo(() => savedFiltersOf(savedSource.config), [savedSource.config]);
  const changes = useMemo(() => {
    const address = dashboardAddress(saved);
    return address.write(address.read(searchParams)).toString();
  }, [saved, searchParams]);
  // Back at the saved filters there is nothing left to check, so a later pick starts without the old notice.
  if (changes === '' && conflict !== null) setConflict(null);
  const filters: WidgetFilters = useMemo(
    () => widgetFiltersOf(applyChanges(saved, dashboardAddress(saved).read(searchParams))),
    [saved, searchParams],
  );
  const hasActiveFilters = Boolean(
    filters.categories || filters.subscriptions || filters.resourceGroups || filters.tags || filters.severities || filters.ruleIds,
  );
  const [refreshKey, setRefreshKey] = useState(0);
  // Outside edit mode a pick applies only to this open page. The saved interval is set in edit mode and
  // saved with the layout, so nothing a person picks while looking changes the dashboard for everyone.
  const [refreshChoice, setRefreshChoice] = useState<RefreshChoice>(NO_REFRESH_CHOICE);
  const savedRefresh = dashboard.config.autoRefresh ?? 0;
  const autoRefresh = pageInterval(savedRefresh, refreshChoice);
  const shownRefresh = shownInterval(editMode, savedRefresh, refreshChoice);
  const [countdown, setCountdown] = useState(0);
  const [configuringWidget, setConfiguringWidget] = useState<WidgetDef | null>(null);
  const [addingWidget, setAddingWidget] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState(dashboard.name);
  const [titleError, setTitleError] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const widgetsRef = useRef(initial.config.widgets);

  /* Both toolbar menus used to be hand-rolled: local open state, a ref and a
     shared document mousedown listener. The shared menu owns all of that now,
     including keyboard navigation and staying inside the viewport. */
  useEffect(() => { widgetsRef.current = widgets; }, [widgets]);
  const { width: gridWidth, containerRef: gridContainerRef } = useContainerWidth({ initialWidth: 1200 });

  // The dashboard has one revision on this page. A counting response computed from a newer one means
  // the dashboard changed underneath it (the saved filters among other things): reload the bar and
  // every number together, and say so. Nothing is saved, and the address stays as it is. A layout edit
  // that is open is not discarded: the page keeps the layout it holds and takes the newer one when the
  // edit ends. The filters are not part of that layout, so the bar and the numbers still reload.
  const layoutEditOpen = editMode || dirty;
  const layoutEditOpenRef = useRef(layoutEditOpen);
  useEffect(() => { layoutEditOpenRef.current = layoutEditOpen; }, [layoutEditOpen]);
  const heldRevision = useRef(initial.revision);
  const handledRevision = useRef(initial.revision);
  useEffect(() => { heldRevision.current = dashboard.revision; }, [dashboard.revision]);
  const onRevision = useCallback((seen: number) => {
    const { view, newer } = seeRevision({ held: heldRevision.current, handled: handledRevision.current }, seen);
    if (!newer) return;
    handledRevision.current = view.handled;
    setNotice(noticeFor(layoutEditOpenRef.current ? 'defer' : 'adopt'));
    router.refresh();
  }, [router]);

  useEffect(() => {
    const action = incomingDashboard({ held: dashboard.revision, incoming: initial.revision, layoutEditOpen });
    if (action === 'defer') {
      // The layout waits, the numbers do not: they are counted from the newest saved filters.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRefreshKey(k => k + 1);
      return;
    }
    if (action !== 'adopt') return;
    // Adopting the reloaded dashboard from props after router.refresh(): an external sync, not derived state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDashboard(initial);
    setWidgets(initial.config.widgets);
    setRefreshKey(k => k + 1);
    setNotice(noticeFor('adopt'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.revision, layoutEditOpen]);

  // The bar is the server's account of the filters, from the same request that counts the numbers, so it
  // follows the newest revision even while a layout edit holds an older layout. Only a bar older than the
  // one shown (the page rendered before this tab saved) is ignored.
  const [shownBar, setShownBar] = useState(bar);
  if (bar !== shownBar && latestOf(shownBar, bar) === bar) setShownBar(bar);
  // A layout save adds or changes a widget override without reloading the page, so the line that says
  // which dimensions widgets override is counted from the dashboard as held.
  const barShown = useMemo(() => withWidgetOverrides(shownBar, dashboard.config.widgets), [shownBar, dashboard.config.widgets]);

  // Every widget below self-fetches from /api/widgets/summary (or its own route) keyed off
  // `refreshKey`: bumping it is the shared "refetch everything" signal for manual refresh and
  // auto-refresh alike, no dashboard-level fetch needed here anymore.
  const fetchData = useCallback(() => {
    setRefreshKey(k => k + 1);
  }, []);

  // Auto-refresh
  useEffect(() => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    // Synchronizing the countdown to an external timer (setInterval), not deriving render state:
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
     MutationObserver is the one that matters: it catches a widget swapping its
     spinner for content, and the ResizeObserver handles the window being resized. */
  useEffect(() => {
    const container = gridContainerRef.current as HTMLElement | null;
    if (!container || editMode) return; // in edit mode the heights are the user's to set

    let raf = 0;
    const ro = new ResizeObserver(() => schedule());

    const measure = () => {
      const current = widgetsRef.current;
      let changed = false;

      // Blocks appear as each widget's fetch resolves, so pick up any that are new
      // since the last pass: a content block that grows later still gets measured.
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
         RGL reports that back through onLayoutChange with new positions, which is
         fine: this pass only ever runs outside edit mode, and a layout change
         outside edit mode never marks the dashboard dirty (see onLayoutChange). */
      widgetsRef.current = next;
      setWidgets(next);
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

  // Layout change from drag/resize, and from RGL's own compaction passes.
  // RGL v2 fires onLayoutChange on mount (and after each state update) with the compacted layout.
  // We compare against the current widget positions. Only sync when something actually moved.
  function onLayoutChange(layout: RGLLayoutArray) {
    const items = layout as RGLLayout[];
    const current = widgetsRef.current;

    const changed = items.some(item => {
      const w = current.find(w => w.id === item.i);
      return w && (w.x !== item.x || w.y !== item.y || w.w !== item.w || w.h !== item.h);
    });

    if (!changed) return; // positions identical: RGL internal re-fire, ignore

    const merged = current.map(w => {
      const l = items.find(i => i.i === w.id);
      return l ? { ...w, x: l.x, y: l.y, w: l.w, h: l.h } : w;
    });
    widgetsRef.current = merged;
    setWidgets(merged);
    /* Machine-made moves arrive through this same callback: the mount-time compaction
       of the stored layout, and the grid re-packing after the fit-to-content shrink
       above. A timing flag used to tell those apart from a person's drag, and lost
       the race whenever two widgets' fits overlapped its 300ms window (exactly what
       a fresh load with a dozen self-fetching widgets does), so the dashboard
       offered "Save changes" to someone who had only opened it. Edit mode is the
       reliable distinction: dragging and resizing exist only there, and the
       fit-to-content pass never runs there. */
    if (!editMode) return;
    setDirty(true);
  }

  // Save the changes in the address as the dashboard's filters. The page sends the revision it holds and
  // adopts the one the server returns, so its own save is never mistaken for someone else's change. A
  // layout edit that is open is untouched: it never carries filters, and the revision it holds moves with this.
  async function saveFilters(changes: DashboardFilterChanges): Promise<SaveOutcome> {
    const before = shownBar;
    const outcome = await sendFiltersSave(
      dashboard.id, revisionToSave({ dashboard: dashboard.revision, bar: shownBar.revision, conflict: conflictRevision }), changes,
    );
    if (outcome.kind === 'saved') {
      setConflictRevision(undefined);
      setDashboard(prev => latestOf(prev, outcome.dashboard));
      setShownBar(outcome.bar);
      setRefreshKey(k => k + 1);
      setNotice(null);
      setConflict(null);
    } else if (outcome.kind === 'conflict') {
      // Nothing was saved. The bar and every number reload from the newer revision, the address stays, and
      // the notice says who changed the saved filters, which dimensions moved under the person, and to
      // check the changes before saving again. A second Save is then a deliberate save over the new revision.
      const after = outcome.bar;
      if (after) setShownBar(prev => latestOf(prev, after));
      onRevision(outcome.revision);
      setConflictRevision(prev => Math.max(prev ?? 0, outcome.revision));
      setConflict(conflictNotice({
        by: outcome.changedBy, at: outcome.changedAt, moved: after ? movedDimensions(before, after, changes) : [],
        layoutEditOpen,
      }));
    } else if (outcome.kind === 'gone') {
      setUnavailable(true);
    } else if (outcome.kind === 'forbidden') {
      setLostEditReason(outcome.message);
    }
    return outcome;
  }

  // Save title rename only
  async function saveTitle(newName: string) {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === dashboard.name) { setEditingTitle(false); setTitleValue(dashboard.name); return; }
    const res = await fetch(`/api/dashboards/${dashboard.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed, revision: dashboard.revision }),
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
  async function save(updatedWidgets: WidgetDef[] = widgets, updatedAutoRefresh = savedInterval(savedRefresh, refreshChoice), updatedName = titleValue) {
    setSaving(true);
    try {
      const res = await fetch(`/api/dashboards/${dashboard.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: updatedName,
          revision: dashboard.revision,
          // A layout save never carries the saved filters or window. Those change only by an explicit save.
          config: layoutConfig(dashboard.config, updatedAutoRefresh, updatedWidgets),
        }),
      });
      if (res.ok) {
        const d = await res.json() as Dashboard;
        setDashboard(d);
        setDirty(false);
        setRefreshChoice(choice => ({ ...choice, draft: null }));
      } else {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? 'Failed to save the dashboard.');
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
    setError(null);
    try {
      const res = await fetch(`/api/dashboards/${dashboard.id}/duplicate`, { method: 'POST' });
      if (!res.ok) {
        setError(res.status === 403 ? 'Duplicating a dashboard needs the Editor Role on the whole install.' : 'Failed to duplicate dashboard.');
        return;
      }
      const copy = await res.json() as Dashboard;
      router.push(`/dashboards/${copy.id}`);
      router.refresh();
    } catch {
      setError('Failed to duplicate dashboard.');
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

  // Sends no request: in edit mode the pick waits for Save, outside it applies to this page only.
  function handleRefreshChange(val: number) {
    const picked = pickInterval(editMode, refreshChoice, val);
    setRefreshChoice(picked.choice);
    if (picked.layoutChanged) setDirty(true);
  }

  const layout: RGLLayout[] = widgets.map(w => ({
    i: w.id, x: w.x, y: w.y, w: w.w, h: w.h, minW: 2, minH: 2,
  }));

  if (unavailable) {
    return (
      <div role="alert" className="flex h-64 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-sm font-semibold text-ink">{UNAVAILABLE_NOTICE}</p>
        <Button size="sm" variant="outline" onClick={() => router.replace('/dashboard')}>Open your dashboards</Button>
      </div>
    );
  }

  return (
    /* No height cap and no scroll container of its own. The app has exactly one
       scroll region (app/(app)/layout.tsx) and this page used to add a second one
       around the grid, which meant the wheel scrolled whichever of the two the
       pointer happened to be over, so scrolling stopped dead partway down and
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
                {shownRefresh === 0 ? 'Off' : REFRESH_OPTIONS.find(o => o.value === shownRefresh)?.label ?? `${shownRefresh}s`}
                <ChevronDown className="size-3" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-32">
            {REFRESH_OPTIONS.map(o => (
              <DropdownMenuItem
                key={o.value}
                onClick={() => handleRefreshChange(o.value)}
                className={cn(shownRefresh === o.value && 'font-semibold')}
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
            <Button size="sm" variant="outline" onClick={() => { setEditMode(false); setWidgets(dashboard.config.widgets); setDirty(false); setRefreshChoice(choice => ({ ...choice, draft: null })); }}>
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
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setEditMode(true)} disabled={!edit.allowed} title={edit.allowed ? undefined : edit.reason}>
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

      {/* Dashboard-level filter bar: writes its picks to the address, never to the dashboard */}
      <DashboardFilterBar state={barShown} saved={saved} marks={outsideAccess} save={{ allowed: edit.allowed, reason: edit.reason, canDuplicate, run: saveFilters, duplicate: handleDuplicate }} />

      {/* Edit mode banner */}
      {editMode && (
        <div className="shrink-0 border-b border-rule-strong bg-surface-sunken px-6 py-2">
          <p className="text-xs font-medium text-ink">Edit mode: drag widgets to rearrange, resize from corners, configure with the gear icon</p>
        </div>
      )}
      </div>

      {error && <Callout tone="error" className="shrink-0 border-b border-rule-strong">{error}</Callout>}
      {(conflict && changes !== '' ? conflict : notice) && (
        <Callout tone="warn" className="shrink-0 border-b border-rule-strong">{conflict && changes !== '' ? conflict : notice}</Callout>
      )}

      {/* Grid */}
      <div className="px-4 py-4" ref={gridContainerRef as React.RefObject<HTMLDivElement>}>
        {widgets.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-4 border border-dashed border-rule-strong">
            <p className="text-sm text-ink-muted">No widgets yet</p>
            <Button size="sm" className="gap-1.5" onClick={() => { setEditMode(true); setAddingWidget(true); }} disabled={!edit.allowed} title={edit.allowed ? undefined : edit.reason}>
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
                  stored={dashboard.config.widgets.find(saved => saved.id === w.id)}
                  dashboardId={dashboard.id}
                  changes={changes}
                  filters={filters}
                  filtered={hasActiveFilters || widgetHasScopeOverrides(w.config)}
                  refreshKey={refreshKey}
                  editMode={editMode}
                  canPreview={edit.allowed}
                  outsideAccess={outsideAccess}
                  onRevision={onRevision}
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
          outsideAccess={outsideAccess}
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
