'use client';

import { useState, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus, Search, Copy, Trash2, Sparkles, Lock, Eye, ExternalLink, GitCommit, Calendar, Shield, X, PanelLeftClose, PanelLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Callout } from '@/components/ui/callout';
import { Input } from '@/components/ui/input';
import {
  Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, TableScroll,
} from '@/components/ui/table';
import { SeverityBadge } from '@/components/findings/severity-badge';
import { CategoryBadge } from '@/components/findings/category-badge';
import { ChecklistDropdown, ColumnFilterIcon } from '@/components/ui/checklist-dropdown';
import { useResizableColumns, ColumnResizeHandle } from '@/lib/hooks/use-resizable-columns';
import { useSidebarPref } from '@/lib/hooks/use-sidebar-pref';
import type { LockedTag } from '@/components/rules/tag-picker';
import { cn } from '@/lib/utils';
import { matchesRuleSearch } from '@/lib/rule-filters';
import { PACK_LABELS } from '@/lib/pack-labels';
import { splitLearnMore } from '@/lib/rule-description';
import { can, type Role } from '@/lib/rbac';
import type { Category, Rule } from '@/lib/types';
import type { PackManifestEntry } from './page';

// ---- Constants ----

const KNOWN_PACKS: Array<{ id: string; label: string }> =
  Object.entries(PACK_LABELS).map(([id, label]) => ({ id, label }));

const PACK_META: Record<string, { fullName: string; summary: string; docsUrl: string }> = {
  'aprl-v2': {
    fullName: 'Azure Proactive Resiliency Library v2',
    summary:
      'APRL is a community-maintained library of resiliency recommendations and Azure Resource Graph (ARG) queries, ' +
      'published and maintained by Microsoft. It helps identify architectural risks across Azure workloads, ' +
      'covering availability zones, redundancy, backup, networking, and more, so you can proactively improve reliability before issues occur.',
    docsUrl: 'https://azure.github.io/Azure-Proactive-Resiliency-Library-v2/',
  },
};

type NavSection = 'all' | `pack:${string}` | 'community' | 'gallery' | 'custom';

const SIDEBAR_RAIL_WIDTH = 40;
const SIDEBAR_EXPANDED_WIDTH = 208;

// ---- Sidebar nav item ----

function NavItem({
  active, count, indent = false, soon = false, onClick, children,
}: {
  active: boolean;
  count?: number;
  indent?: boolean;
  soon?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  // Marked the same way as the app's own sidebar: a bar down the left edge plus
  // weight, never a colour. Colour in this product means severity.
  return (
    <button
      onClick={onClick}
      disabled={soon}
      className={cn(
        'relative flex w-full items-center gap-2 py-1.5 pl-3 pr-2.5 text-left text-sm transition-colors',
        indent && 'pl-6 text-[13px]',
        active
          ? 'bg-sidebar-accent font-medium text-ink'
          : 'text-ink-2 hover:bg-surface-hover hover:text-ink',
        soon && 'cursor-default opacity-40',
      )}
    >
      {active && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-ink" />}
      <span className="min-w-0 flex-1 truncate leading-none">{children}</span>
      {soon && (
        <span className="label-grid shrink-0 bg-surface-sunken px-1 py-0.5">Soon</span>
      )}
      {count !== undefined && !soon && (
        <span className={cn('numeral-grid shrink-0 text-xs', active ? 'font-semibold text-ink' : 'text-ink-2')}>
          {count}
        </span>
      )}
    </button>
  );
}

// ---- Type → locked tag ----
// Type/pack is a permission-bearing field (drives delete/edit rights), kept separate in the
// data model — but displayed as a regular (locked) tag chip alongside user tags, not a distinct badge.

function lockedTagFor(rule: Rule): LockedTag {
  if (rule.type === 'builtin') return { label: 'Built-in', icon: 'lock' };
  if (rule.type === 'community') return { label: 'Community', icon: 'sparkles' };
  return { label: 'Custom' };
}

// Pack (e.g. "APRL v2") is a sub-classification within type: 'builtin' — shown as its own
// locked tag in the Tags column, separate from the Type column.
function packTagFor(rule: Rule): LockedTag | null {
  if (rule.type !== 'builtin') return null;
  const pack = rule.pack ?? 'rulebeat-core';
  return { label: PACK_LABELS[pack] ?? pack, icon: 'lock' };
}

// ---- Empty section ----
// One component for the three "nothing here" panels. They were three copies of the
// same markup that had already drifted apart, and each one is a different reason for
// being empty, so the wording has to carry the difference rather than the layout.

function EmptySection({
  icon: Icon, title, body, action,
}: {
  icon: React.ElementType;
  title: string;
  body: string;
  action?: { href: string; label: string };
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-4 py-20 text-center">
        <div className="flex size-11 items-center justify-center bg-surface-sunken">
          <Icon className="size-5 text-ink-muted" />
        </div>
        <div>
          <h3 className="title-grid mb-1">{title}</h3>
          <p className="max-w-sm text-sm text-ink-muted">{body}</p>
        </div>
        {action && (
          <Link href={action.href}>
            <Button variant="outline" size="sm"><Plus className="size-4" />{action.label}</Button>
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

// ---- Pack info banner ----

function PackInfoBanner({ packId, manifest }: { packId: string; manifest: Record<string, PackManifestEntry> }) {
  const info = manifest[packId];
  if (!info) return null;
  const meta = PACK_META[packId];
  const shortCommit = info.pinnedCommit.slice(0, 7);
  return (
    <div className="space-y-3 bg-surface-sunken p-4">

      {/* Title row */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="title-grid">
              {meta?.fullName ?? info.label}
            </h2>
            <span className="text-xs font-medium text-ink">({info.label})</span>
          </div>
          {/* Licence and rule count are facts about the pack, not warnings about it,
              so they are plain chips. The old green licence badge read as a status. */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 bg-surface px-1.5 py-0.5 text-xs font-medium text-ink-2">
              <Shield className="size-2.5 shrink-0" />
              {info.license} license
            </span>
            <span className="numeral-grid bg-surface px-1.5 py-0.5 text-xs font-medium text-ink-2">
              {info.policyCount} rules
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {meta?.docsUrl && (
            <a href={meta.docsUrl} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-ink underline-offset-2 hover:underline">
              <ExternalLink className="size-3" />
              Documentation
            </a>
          )}
          <a href={info.source} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-ink-2 underline-offset-2 transition-colors hover:text-ink hover:underline">
            <ExternalLink className="size-3" />
            GitHub
          </a>
        </div>
      </div>

      {/* Summary */}
      {meta?.summary && (
        <p className="text-xs leading-relaxed text-ink-2">{meta.summary}</p>
      )}

      {/* Footer: attribution + version info */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-2.5">
        <p className="text-xs text-ink-faint">{info.attribution}</p>
        <div className="flex shrink-0 items-center gap-4 text-xs text-ink-muted">
          <span className="flex items-center gap-1" title={info.pinnedCommit}>
            <GitCommit className="size-3 shrink-0" />
            Source snapshot <code className="font-mono text-ink-2">{shortCommit}</code>
          </span>
          <span className="flex items-center gap-1">
            <Calendar className="size-3 shrink-0" />
            Rules as of {info.syncedAt}
          </span>
        </div>
      </div>
    </div>
  );
}

// ---- Main component ----

export function LibraryClient({ initialRules, initialSection, packManifest, categories, initialSidebarPinned, role }: { initialRules: Rule[]; initialSection?: string; packManifest: Record<string, PackManifestEntry>; categories: Category[]; initialSidebarPinned: boolean; role: Role }) {
  const canAuthor = can(role, 'rules:write');
  const router = useRouter();
  const [rules, setRules] = useState<Rule[]>(initialRules);
  const [error, setError] = useState<string | null>(null);
  const initialTag = initialSection?.startsWith('tag:') ? initialSection.slice(4) : undefined;
  const initialNav = (initialSection && !initialSection.startsWith('tag:'))
    ? (initialSection as NavSection)
    : 'all';
  const [nav, setNavRaw] = useState<NavSection>(initialNav);

  const setNav = useCallback((section: NavSection) => {
    setNavRaw(section);
    router.replace(`/library?section=${encodeURIComponent(section)}`, { scroll: false });
  }, [router]);
  const [search, setSearch] = useState('');
  // Per-column Excel-style filters (funnel icon in each header) — multi-select, empty set = no filter.
  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set());
  const [categoryFilter, setCategoryFilter] = useState<Set<string>>(new Set());
  const [severityFilter, setSeverityFilter] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set(initialTag ? [initialTag] : []));

  const { widths: colWidths, startResize, isFlexible } = useResizableColumns<'rule' | 'type' | 'tags' | 'category' | 'severity' | 'status'>(
    // Rule is the flex column, so every pixel the other five don't take goes to it.
    // With the Rules rail open there are only about 1000px to share, and the name is
    // the one column whose content is genuinely variable — the rest hold a chip or a
    // single word. They were sized well above what they show, which squeezed the names
    // into two lines and left the table looking ragged.
    { rule: 320, type: 100, tags: 170, category: 120, severity: 100, status: 100 },
    { flexCol: 'rule' },
  );

  const { pinned: sidebarPinned, expanded: sidebarExpanded, setPinned: setSidebarPinned, hoverHandlers: sidebarHoverHandlers } = useSidebarPref('sidebar:library', initialSidebarPinned);
  const sidebarOverlay = sidebarExpanded && !sidebarPinned;
  const sidebarAsideWidth = sidebarExpanded ? SIDEBAR_EXPANDED_WIDTH : SIDEBAR_RAIL_WIDTH;
  // The wrapper reserves real layout space equal to the aside's width — except in overlay mode,
  // where the aside flies out over the table and the wrapper stays at the rail width instead.
  const sidebarWrapperWidth = sidebarOverlay ? SIDEBAR_RAIL_WIDTH : sidebarAsideWidth;

  const categoryById = useMemo(() => new Map(categories.map(c => [c.id, c])), [categories]);

  // Derived sidebar counts
  const counts = useMemo(() => {
    const packs = new Map<string, number>();
    const tags = new Map<string, number>();
    let community = 0, custom = 0;
    for (const r of rules) {
      if (r.type === 'builtin') {
        const k = r.pack ?? 'rulebeat-core';
        packs.set(k, (packs.get(k) ?? 0) + 1);
      } else if (r.type === 'community') community++;
      else custom++;
      for (const t of r.tags ?? []) tags.set(t, (tags.get(t) ?? 0) + 1);
    }
    return { total: rules.length, packs, community, custom, tags };
  }, [rules]);

  const allTagNames = useMemo(() =>
    [...counts.tags.keys()].sort((a, b) => a.localeCompare(b)),
  [counts.tags]);

  const tagOptions = useMemo(() =>
    allTagNames.map(t => ({ value: t, label: t, count: counts.tags.get(t) ?? 0 })),
  [allTagNames, counts.tags]);

  const toggleTagFilter = useCallback((tag: string) => {
    setTagFilter(s => {
      const next = new Set(s);
      if (next.has(tag)) next.delete(tag); else next.add(tag);
      return next;
    });
  }, []);

  function toggleSetValue(setter: (fn: (prev: Set<string>) => Set<string>) => void, value: string) {
    setter(prev => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value); else next.add(value);
      return next;
    });
  }

  // Base filters (nav section + tags + search) — shared between the visible-rows list and the
  // per-column filter option builder below.
  const passesBaseFilters = useCallback((r: Rule) => {
    if (nav === 'gallery') return false;
    if (nav.startsWith('pack:')) {
      const pack = nav.slice(5);
      if (r.type !== 'builtin' || (r.pack ?? 'rulebeat-core') !== pack) return false;
    } else if (nav === 'community'       && r.type !== 'community')     return false;
    else if (nav === 'custom'            && r.type !== 'custom')        return false;
    if (tagFilter.size > 0 && !(r.tags ?? []).some(t => tagFilter.has(t))) return false;
    if (!matchesRuleSearch(r, search, categoryById.get(r.category)?.label)) return false;
    return true;
  }, [nav, tagFilter, search, categoryById]);

  type ColKey = 'type' | 'category' | 'severity' | 'status';
  const passesColFilters = useCallback((r: Rule, exclude?: ColKey) => {
    if (exclude !== 'type'     && typeFilter.size     > 0 && !typeFilter.has(r.type))                          return false;
    if (exclude !== 'category' && categoryFilter.size > 0 && !categoryFilter.has(r.category))                  return false;
    if (exclude !== 'severity' && severityFilter.size > 0 && !severityFilter.has(r.severity))                  return false;
    if (exclude !== 'status'   && statusFilter.size   > 0 && !statusFilter.has(r.enabled ? 'enabled' : 'disabled')) return false;
    return true;
  }, [typeFilter, categoryFilter, severityFilter, statusFilter]);

  // Visible rows
  const visible = useMemo(
    () => rules.filter(r => passesBaseFilters(r) && passesColFilters(r)),
    [rules, passesBaseFilters, passesColFilters],
  );

  // Per-column filter option lists — built from the pool excluding that column's own selection
  // (so picking a value never makes the dropdown's other options vanish), values sourced
  // straight from live data rather than a static list (keeps orphaned/legacy values findable).
  const colOptions = useMemo(() => {
    function build(col: ColKey, getValue: (r: Rule) => string, getLabel: (v: string) => string) {
      const pool = rules.filter(r => passesBaseFilters(r) && passesColFilters(r, col));
      const counts = new Map<string, number>();
      for (const r of pool) { const v = getValue(r); counts.set(v, (counts.get(v) ?? 0) + 1); }
      return [...counts.entries()]
        .map(([value, count]) => ({ value, count, label: getLabel(value) }))
        .sort((a, b) => a.label.localeCompare(b.label));
    }
    return {
      type: build('type', r => r.type, v => v === 'builtin' ? 'Built-in' : v === 'community' ? 'Community' : 'Custom'),
      category: build('category', r => r.category, v => categoryById.get(v)?.label ?? v),
      severity: build('severity', r => r.severity, v => v.charAt(0).toUpperCase() + v.slice(1)),
      status: build('status', r => r.enabled ? 'enabled' : 'disabled', v => v === 'enabled' ? 'Enabled' : 'Disabled'),
    };
  }, [rules, passesBaseFilters, passesColFilters, categoryById]);

  const hasActiveFilter = search !== '' || tagFilter.size > 0 || typeFilter.size > 0 || categoryFilter.size > 0 || severityFilter.size > 0 || statusFilter.size > 0;
  const clearFilters = useCallback(() => {
    setSearch(''); setTagFilter(new Set()); setTypeFilter(new Set());
    setCategoryFilter(new Set()); setSeverityFilter(new Set()); setStatusFilter(new Set());
  }, []);

  // ---- Handlers ----
  // Enable/disable is not editable from the Library — that's an operational concern owned by
  // the Scans page (per-category "what runs"). The Library stays read-only status here (dot + filter).

  const handleDuplicate = useCallback(async (rule: Rule) => {
    setError(null);
    try {
      const res = await fetch(`/api/rules/${encodeURIComponent(rule.id)}/duplicate`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? 'Failed to duplicate rule.');
        return;
      }
      const copy = await res.json() as Rule;
      setRules(rs => [...rs, copy]);
      router.push(`/rules/${encodeURIComponent(copy.id)}`);
    } catch {
      setError('Failed to duplicate rule.');
    }
  }, [router]);

  const handleDelete = useCallback(async (rule: Rule) => {
    if (!confirm(`Delete "${rule.name}"? This cannot be undone.`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/rules/${encodeURIComponent(rule.id)}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? 'Failed to delete rule.');
        return;
      }
      setRules(rs => rs.filter(r => r.id !== rule.id));
    } catch {
      setError('Failed to delete rule.');
    }
  }, []);

  const isGallery       = nav === 'gallery';
  const isCommunityEmpty = nav === 'community' && counts.community === 0;
  const isCustomEmpty   = nav === 'custom'    && counts.custom    === 0;

  return (
    <div className="flex gap-6">

      {/* ── Sidebar ── */}
      <div
        className="relative shrink-0"
        style={{ width: sidebarWrapperWidth }}
        {...sidebarHoverHandlers}
      >
        <aside
          className={cn(
            'absolute inset-y-0 left-0 z-20 space-y-0.5 transition-[width] duration-200',
            sidebarOverlay && 'border border-rule-strong bg-surface p-2 shadow-overlay',
          )}
          style={{ width: sidebarAsideWidth }}
        >
          {/* Header: section label + pin toggle — uses the same PanelLeft/PanelLeftClose icon
              pair as the main sidebar's own toggle, so "this collapses/pins" reads consistently
              across both, rather than repurposing the Library nav icon as decoration. */}
          <div className={cn('mb-2 flex h-8 items-center', sidebarExpanded ? 'justify-between pl-2 pr-1' : 'justify-center')}>
            {sidebarExpanded && <span className="label-grid select-none">Rules</span>}
            <button
              onClick={() => setSidebarPinned(!sidebarPinned)}
              title={sidebarPinned ? 'Collapse sidebar' : 'Pin sidebar open'}
              className="flex size-7 shrink-0 items-center justify-center text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
            >
              {sidebarExpanded ? <PanelLeftClose className="size-4" /> : <PanelLeft className="size-4" />}
            </button>
          </div>

          {sidebarExpanded && (
            <>
              <NavItem active={nav === 'all'} count={counts.total} onClick={() => setNav('all')}>
                All rules
              </NavItem>

              {/* Built-in */}
              <div className="px-3 pb-1.5 pt-4">
                <span className="label-grid select-none">Built-in</span>
              </div>
              <div className="space-y-0.5">
                {KNOWN_PACKS.map(({ id, label }) => {
                  const count = counts.packs.get(id) ?? 0;
                  const isSoon = count === 0;
                  return (
                    <NavItem
                      key={id} indent
                      active={nav === `pack:${id}`}
                      count={isSoon ? undefined : count}
                      soon={isSoon}
                      onClick={() => { if (!isSoon) setNav(`pack:${id}` as NavSection); }}
                    >
                      {label}
                    </NavItem>
                  );
                })}
              </div>

              <div className="border-t border-border mx-3 pt-3 mt-3 space-y-0.5">
                <NavItem active={nav === 'community'} count={counts.community} onClick={() => setNav('community')}>
                  Community
                </NavItem>
                <NavItem active={nav === 'gallery'} onClick={() => setNav('gallery')} soon>
                  Gallery
                </NavItem>
              </div>

              <div className="border-t border-border mx-3 pt-3 mt-3">
                <NavItem active={nav === 'custom'} count={counts.custom} onClick={() => setNav('custom')}>
                  Custom
                </NavItem>
              </div>
            </>
          )}
        </aside>
      </div>

      {/* ── Main content ── */}
      <div className="flex-1 min-w-0 space-y-4">

        {error && <Callout tone="error">{error}</Callout>}

        {/* Pack info banner */}
        {nav.startsWith('pack:') && (
          <PackInfoBanner packId={nav.slice(5)} manifest={packManifest} />
        )}

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name, tag, category, ID…"
              className="pl-9"
            />
          </div>

          {tagOptions.length > 0 && (
            <ChecklistDropdown
              label="Tags"
              options={tagOptions}
              selected={tagFilter}
              onToggle={toggleTagFilter}
              onClear={() => setTagFilter(new Set())}
            />
          )}

          {hasActiveFilter && (
            <Button variant="outline" size="sm" onClick={clearFilters}>
              <X className="size-3.5" />
              Clear
            </Button>
          )}

          {canAuthor && (
            <Link href="/rules/new" className="ml-auto">
              <Button variant="outline" size="sm">
                <Plus className="size-4" />
                New rule
              </Button>
            </Link>
          )}
        </div>
        <p className="-mt-2 text-xs text-ink-muted">Type, Category, Severity and Status are filterable from the funnel icon in their column header below.</p>

        {/* Gallery stub */}
        {isGallery ? (
          <EmptySection
            icon={Sparkles}
            title="Community Gallery"
            body="Browse and add community-contributed rules. Coming soon. In the meantime, create a custom rule."
            action={canAuthor ? { href: '/rules/new', label: 'Create a rule' } : undefined}
          />

        ) : isCommunityEmpty ? (
          <EmptySection
            icon={Sparkles}
            title="No community rules yet"
            body="Community rules will appear here once the gallery launches, or when you import one from a file."
          />

        ) : isCustomEmpty ? (
          <EmptySection
            icon={Plus}
            title="No custom rules yet"
            body="Create your own rule from scratch, or duplicate any built-in to customise it."
            action={canAuthor ? { href: '/rules/new', label: 'New rule' } : undefined}
          />

        ) : (
          <Card>
            {/* Sideways scroll only, and no height cap: the list runs to its full length
                and the page scrolls, the way a long page is read anywhere else. The
                header no longer sticks, because a container that scrolls horizontally
                is itself the scroll container sticky binds to, and that container never
                scrolls vertically. One or the other, and resizable columns need this one. */}
            <TableScroll>
            <Table style={{ tableLayout: 'fixed', width: isFlexible('rule') ? '100%' : 'max-content', minWidth: '100%' }}>
              <colgroup>
                {/* Rule column has no explicit width while unresized — fixed-layout tables give any
                    column without a width the leftover space, which is what keeps the table filled
                    edge-to-edge by default instead of shrinking to the sum of the other columns. */}
                <col style={isFlexible('rule') ? undefined : { width: colWidths.rule }} />
                <col style={{ width: colWidths.type }} />
                <col style={{ width: colWidths.tags }} />
                <col style={{ width: colWidths.category }} />
                <col style={{ width: colWidths.severity }} />
                <col style={{ width: colWidths.status }} />
                <col style={{ width: 112 }} />
              </colgroup>
              <TableHeader>
                <TableRow>
                  <TableHead className="relative">
                    Rule
                    <ColumnResizeHandle onMouseDown={startResize('rule')} />
                  </TableHead>
                  <TableHead className="relative">
                    <span className="flex items-center gap-1">
                      Type
                      <ColumnFilterIcon label="Type" options={colOptions.type} selected={typeFilter} onToggle={v => toggleSetValue(setTypeFilter, v)} onClear={() => setTypeFilter(new Set())} />
                    </span>
                    <ColumnResizeHandle onMouseDown={startResize('type')} />
                  </TableHead>
                  <TableHead className="relative">
                    Tags
                    <ColumnResizeHandle onMouseDown={startResize('tags')} />
                  </TableHead>
                  <TableHead className="relative">
                    <span className="flex items-center gap-1">
                      Category
                      <ColumnFilterIcon label="Category" options={colOptions.category} selected={categoryFilter} onToggle={v => toggleSetValue(setCategoryFilter, v)} onClear={() => setCategoryFilter(new Set())} />
                    </span>
                    <ColumnResizeHandle onMouseDown={startResize('category')} />
                  </TableHead>
                  <TableHead className="relative">
                    <span className="flex items-center gap-1">
                      Severity
                      <ColumnFilterIcon label="Severity" options={colOptions.severity} selected={severityFilter} onToggle={v => toggleSetValue(setSeverityFilter, v)} onClear={() => setSeverityFilter(new Set())} />
                    </span>
                    <ColumnResizeHandle onMouseDown={startResize('severity')} />
                  </TableHead>
                  <TableHead className="relative">
                    <span className="flex items-center gap-1">
                      Status
                      <ColumnFilterIcon label="Status" options={colOptions.status} selected={statusFilter} onToggle={v => toggleSetValue(setStatusFilter, v)} onClear={() => setStatusFilter(new Set())} />
                    </span>
                    <ColumnResizeHandle onMouseDown={startResize('status')} />
                  </TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.length === 0 ? (
                  <TableEmpty colSpan={7}>
                    {hasActiveFilter
                      ? 'No rules match your filters.'
                      : 'No rules in this section yet.'}
                  </TableEmpty>
                ) : visible.map(rule => (
                  <TableRow
                    key={rule.id}
                    className={cn('group transition-colors hover:bg-surface-hover', !rule.enabled && 'opacity-60')}
                  >
                    {/* Name. No max-width of its own: the table is table-layout:fixed, so the
                        colgroup already decides how wide this is and a second cap here only
                        made the text stop short of the column edge. */}
                    <TableCell className="py-3">
                      <Link
                        href={`/rules/${encodeURIComponent(rule.id)}`}
                        className="text-sm font-medium text-ink underline-offset-2 hover:underline"
                      >
                        {rule.name}
                      </Link>
                      {/* One line, not two. The library holds 156 rules and a two-line
                          description put each row at 110px, so eight rules filled the
                          screen and finding one meant scrolling past twenty. This list is
                          for locating a rule; the full text is on the rule's own page. */}
                      {rule.description && (
                        <p className="mt-1 line-clamp-1 text-xs leading-relaxed text-ink-2">
                          {splitLearnMore(rule.description).text}
                        </p>
                      )}
                    </TableCell>

                    {/* Type — read-only, derived from source/pack (permission-bearing, not user-editable) */}
                    <TableCell className="py-3">
                      {(() => {
                        const lt = lockedTagFor(rule);
                        return (
                          <span
                            title={rule.type === 'builtin' ? 'Built-in, read-only' : lt.label}
                            className="inline-flex items-center gap-1 bg-surface-sunken px-1.5 py-0.5 text-xs font-medium text-ink-2"
                          >
                            {lt.icon === 'sparkles' ? <Sparkles className="size-2.5 shrink-0" /> : lt.icon === 'lock' ? <Lock className="size-2.5 shrink-0" /> : null}
                            {lt.label}
                          </span>
                        );
                      })()}
                    </TableCell>

                    {/* Tags — read-only here; edit from the rule's own page to prevent accidental
                        add/remove from the list. Clicking a tag chip filters the list to it. */}
                    <TableCell className="max-w-[240px] py-3">
                      <div className="flex flex-wrap items-center gap-1">
                        {(() => {
                          const pt = packTagFor(rule);
                          return pt && (
                            <span
                              title="Source pack"
                              className="inline-flex items-center gap-1 bg-surface-sunken px-1.5 py-0.5 text-xs font-medium text-ink-2"
                            >
                              <Lock className="size-2.5 shrink-0" />
                              {pt.label}
                            </span>
                          );
                        })()}
                        {/* A selected tag inverts rather than turning a different colour, so
                            "this filter is on" reads at a glance without adding a hue that
                            would compete with severity. */}
                        {(rule.tags ?? []).map(t => (
                          <button
                            key={t}
                            onClick={() => toggleTagFilter(t)}
                            title={`Filter by "${t}"`}
                            className={cn(
                              'inline-flex items-center gap-1 border px-1.5 py-0.5 text-xs font-medium transition-colors',
                              tagFilter.has(t)
                                ? 'border-ink bg-ink text-surface'
                                : 'border-border text-ink-2 hover:border-rule-strong hover:text-ink',
                            )}
                          >
                            {t}
                          </button>
                        ))}
                      </div>
                    </TableCell>

                    {/* Category — same component as every other table, so the mark and spacing
                        match. The colour is the user's own choice from Settings and stays as a
                        swatch: an arbitrary hex used as both text and background colour cannot be
                        relied on to stay legible on either ground. */}
                    <TableCell className="py-3">
                      <CategoryBadge id={rule.category} categories={categories} />
                    </TableCell>

                    {/* Severity */}
                    <TableCell className="py-3">
                      <SeverityBadge severity={rule.severity} />
                    </TableCell>

                    {/* Status — read-only; toggle from the Scans page */}
                    <TableCell className="py-3">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 text-xs font-medium',
                          rule.enabled ? 'text-ink' : 'text-ink-faint',
                        )}
                        title={rule.enabled ? 'Enabled. Toggle from Scans' : 'Disabled. Toggle from Scans'}
                      >
                        {/* Filled means on, hollow means off. Enabled is what 156 of 156 rules
                            are on a fresh install, so the mark has to stay quiet: a solid ink
                            square on every row is the loudest thing in the table on a dark
                            ground, which is the same mistake as the green dot it replaced.
                            Shape carries the difference, tone keeps it from shouting. */}
                        <span
                          className={cn(
                            'size-2 shrink-0',
                            rule.enabled ? 'bg-ink-muted' : 'border border-ink-faint',
                          )}
                        />
                        {rule.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </TableCell>

                    {/* Actions */}
                    <TableCell className="py-3">
                      <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        <Link href={`/rules/${encodeURIComponent(rule.id)}`}>
                          <Button variant="ghost" size="icon-sm" title="View rule">
                            <Eye className="size-3.5" />
                          </Button>
                        </Link>
                        {canAuthor && (
                          <Button
                            variant="ghost" size="icon-sm"
                            title="Duplicate as Custom"
                            onClick={() => { void handleDuplicate(rule); }}
                          >
                            <Copy className="size-3.5" />
                          </Button>
                        )}
                        {canAuthor && rule.type !== 'builtin' && (
                          <Button
                            variant="ghost" size="icon-sm"
                            title="Delete rule"
                            className="hover:text-sev-critical"
                            onClick={() => { void handleDelete(rule); }}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </TableScroll>
          </Card>
        )}
      </div>
    </div>
  );
}
