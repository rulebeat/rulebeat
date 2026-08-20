'use client';

import { useState, useEffect } from 'react';
import { X, Save, Search, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ChecklistDropdown } from '@/components/ui/checklist-dropdown';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { SlideOverPanel } from '@/components/dashboard/slide-over-panel';
import type { WidgetDef, WidgetType, StatMetric, Category, FilterOptionsResponse } from '@/lib/types';
import { cn } from '@/lib/utils';

interface PolicyOption { id: string; name: string; category: string; enabled?: boolean }

// Module-level component — must NOT be defined inside another component or React will
// unmount/remount it on every parent re-render, causing the search input to lose focus.
interface PolicyPickerProps {
  policies: PolicyOption[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  onClear: () => void;
  /** Show the "trend/delta unavailable" caveat once rules are selected — only true for widget
   *  types that actually render a trend chart or a vs-previous delta (stat-card, posture-ring,
   *  trend, new-vs-fixed); mirrors `trendIsCategoryScopedOnly` in dashboard-data.ts. */
  trendCaveat?: boolean;
}
function PolicyPicker({ policies, selectedIds, onToggle, onClear, trendCaveat }: PolicyPickerProps) {
  const [search, setSearch] = useState('');
  const filtered = search
    ? policies.filter(p =>
        p.name.toLowerCase().includes(search.toLowerCase()) ||
        p.category.toLowerCase().includes(search.toLowerCase()))
    : policies;

  return (
    <div className="space-y-1.5">
      <Label>
        Rules{selectedIds.length > 0 ? ` (${selectedIds.length} selected)` : ''}
      </Label>
      <div className="border border-rule-strong">
        <div className="flex items-center gap-2 border-b border-border bg-surface-sunken px-2.5 py-2">
          <Search className="size-3.5 shrink-0 text-ink-faint" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search rules…"
            className="flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-faint"
          />
          {search && (
            <button onClick={() => setSearch('')} className="text-ink-muted transition-colors hover:text-ink">
              <X className="size-3" />
            </button>
          )}
        </div>
        {/* Bounded, but by the viewport rather than a fixed 11rem. This list can hold
            every rule in the tenant and it lives inside a panel that already scrolls,
            so it does need a ceiling; what it does not need is one that shows four rows
            on a laptop and four rows on a 4K display. */}
        <div className="scroll-y max-h-[min(22rem,45vh)]">
          {filtered.length === 0 ? (
            <p className="px-3 py-3 text-center text-xs text-ink-muted">
              {policies.length === 0 ? 'Loading…' : 'No matches'}
            </p>
          ) : (
            filtered.map(p => (
              <button
                key={p.id}
                type="button"
                onClick={() => onToggle(p.id)}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors hover:bg-surface-hover"
              >
                <div className={cn(
                  'flex size-3.5 shrink-0 items-center justify-center border transition-colors',
                  selectedIds.includes(p.id) ? 'border-ink bg-ink' : 'border-rule-strong',
                )}>
                  {selectedIds.includes(p.id) && <Check className="size-2.5 text-surface" />}
                </div>
                <span className="flex-1 truncate text-ink">{p.name}</span>
                <span className={cn('shrink-0 text-xs capitalize', p.enabled === false ? 'text-ink-faint' : 'text-ink-2')}>
                  {p.category}{p.enabled === false ? ' · off' : ''}
                </span>
              </button>
            ))
          )}
        </div>
        {selectedIds.length > 0 && (
          <div className="border-t border-border bg-surface-sunken px-3 py-1.5">
            <button type="button" onClick={onClear} className="text-xs text-ink-2 transition-colors hover:text-ink">
              Clear ({selectedIds.length})
            </button>
          </div>
        )}
      </div>
      {selectedIds.length === 0 ? (
        <p className="text-xs text-ink-muted">Leave empty to include all rules.</p>
      ) : trendCaveat && (
        <p className="text-xs text-ink-muted">Trend and vs-baseline delta aren&apos;t available for rule-scoped widgets. Only the current pass/fail count.</p>
      )}
    </div>
  );
}

const SEVERITY_LABELS: Array<{ value: string; label: string }> = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
  { value: 'info', label: 'Info' },
];

interface Props {
  widget: WidgetDef | null;
  onClose: () => void;
  onSave: (updated: WidgetDef) => void;
}

const STAT_METRICS: Array<{ value: StatMetric; label: string }> = [
  { value: 'posture-pct',       label: 'Overall Posture %' },
  { value: 'total-findings',    label: 'Total Open Findings' },
  { value: 'critical-findings', label: 'Critical Findings' },
  { value: 'high-findings',     label: 'High Severity Findings' },
  { value: 'rules-scanned',     label: 'Rules Scanned' },
  { value: 'modules-healthy',   label: 'Healthy Categories' },
  { value: 'new-findings',      label: 'New Findings (window)' },
  { value: 'fixed-findings',    label: 'Fixed Findings (window)' },
];

const CHART_TYPES = [
  { value: 'area', label: 'Area Chart' },
  { value: 'line', label: 'Line Chart' },
  { value: 'bar',  label: 'Bar Chart' },
];

const PERIODS = [
  { value: '7d',  label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
];

// finding_events retention is 180 days — an "All time" label would overpromise here.
const EVENT_PERIODS = [
  { value: '7d',  label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'all', label: 'All history (180d)' },
];

const WINDOW_OVERRIDE_OPTIONS = [
  { value: 'inherit', label: 'Inherit dashboard filter' },
  { value: '1', label: '24h' },
  { value: '7', label: '7d' },
  { value: '30', label: '30d' },
];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

/* These three used to be local copies of a text field, a number field and a native
 * <select>, each with their own height and focus ring. They are thin wrappers over the
 * shared primitives now, kept only because every call site here passes a plain value
 * and a plain setter rather than a DOM event. */

function TextInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <Input inputSize="sm" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />
  );
}

function NumberInput({ value, onChange, min = 1, max = 100 }: { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  return (
    <Input
      inputSize="sm"
      type="number"
      value={value}
      onChange={e => onChange(Number(e.target.value))}
      min={min}
      max={max}
    />
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2">
      <Switch checked={checked} onCheckedChange={onChange} />
      <span className="text-sm text-ink">{label}</span>
    </label>
  );
}

// ── Shared "Scope" section — every widget type reads the dashboard filter bar via
// mergeWidgetFilters (see lib/dashboard-filters.ts); this is the one place that lets a widget
// override any of its seven dimensions instead of inheriting. Type-specific options (metric,
// chart type, limit…) render separately, below this. ──────────────────────────────────────────
interface ScopeSectionProps {
  cfg: Record<string, unknown>;
  setConfig: (key: string, value: unknown) => void;
  categories: Category[];
  subscriptions: string[];
  resourceGroups: string[];
  tags: string[];
  policies: PolicyOption[];
  trendCaveat?: boolean;
}
function ScopeSection({ cfg, setConfig, categories, subscriptions, resourceGroups, tags, policies, trendCaveat }: ScopeSectionProps) {
  const selectedPolicyIds: string[] = Array.isArray(cfg.policyIds) ? cfg.policyIds as string[] : [];
  const selectedSubs: string[] = Array.isArray(cfg.subscriptions) ? cfg.subscriptions as string[] : [];
  const selectedRGs: string[] = Array.isArray(cfg.resourceGroups) ? cfg.resourceGroups as string[] : [];
  const selectedTags: string[] = Array.isArray(cfg.tags) ? cfg.tags as string[] : [];
  const selectedSevs: string[] = Array.isArray(cfg.severities) ? cfg.severities as string[] : [];
  const windowValue = (cfg.windowDays === 1 || cfg.windowDays === 7 || cfg.windowDays === 30) ? String(cfg.windowDays) : 'inherit';

  const inheritCategoryOptions = [
    { value: 'all', label: 'Inherit dashboard filter' },
    ...categories.map(c => ({ value: c.id, label: c.label })),
  ];

  function toggleList(key: 'subscriptions' | 'resourceGroups' | 'tags' | 'severities', current: string[], value: string) {
    const next = current.includes(value) ? current.filter(v => v !== value) : [...current, value];
    setConfig(key, next);
  }
  function togglePolicy(id: string) {
    const next = selectedPolicyIds.includes(id) ? selectedPolicyIds.filter(p => p !== id) : [...selectedPolicyIds, id];
    setConfig('policyIds', next);
  }

  return (
    <div className="space-y-4">
      <PolicyPicker
        policies={policies}
        selectedIds={selectedPolicyIds}
        onToggle={togglePolicy}
        onClear={() => setConfig('policyIds', [])}
        trendCaveat={trendCaveat}
      />
      {selectedPolicyIds.length === 0 && (
        <Field label="Category">
          <Select size="sm" value={String(cfg.category ?? 'all')} onValueChange={v => setConfig('category', v)} options={inheritCategoryOptions} />
        </Field>
      )}
      <Field label="Additional scope (optional overrides)">
        <div className="flex flex-wrap gap-2">
          <ChecklistDropdown
            label="Subscription"
            options={subscriptions.map(s => ({ value: s, label: s }))}
            selected={new Set(selectedSubs)}
            onToggle={v => toggleList('subscriptions', selectedSubs, v)}
            onClear={() => setConfig('subscriptions', [])}
          />
          <ChecklistDropdown
            label="Resource Group"
            options={resourceGroups.map(r => ({ value: r, label: r }))}
            selected={new Set(selectedRGs)}
            onToggle={v => toggleList('resourceGroups', selectedRGs, v)}
            onClear={() => setConfig('resourceGroups', [])}
          />
          <ChecklistDropdown
            label="Tags"
            options={tags.map(t => ({ value: t, label: t }))}
            selected={new Set(selectedTags)}
            onToggle={v => toggleList('tags', selectedTags, v)}
            onClear={() => setConfig('tags', [])}
          />
          <ChecklistDropdown
            label="Severity"
            options={SEVERITY_LABELS}
            selected={new Set(selectedSevs)}
            onToggle={v => toggleList('severities', selectedSevs, v)}
            onClear={() => setConfig('severities', [])}
          />
        </div>
      </Field>
      <Field label="Window">
        <Select
          size="sm"
          value={windowValue}
          onValueChange={v => setConfig('windowDays', v === 'inherit' ? undefined : Number(v))}
          options={WINDOW_OVERRIDE_OPTIONS}
        />
      </Field>
    </div>
  );
}

export function WidgetConfigPanel({ widget, onClose, onSave }: Props) {
  const [local, setLocal] = useState<WidgetDef | null>(widget);
  const [policies, setPolicies] = useState<PolicyOption[]>([]);
  const [options, setOptions] = useState<FilterOptionsResponse>({ categories: [], tags: [], subscriptions: [], resourceGroups: [], rules: [] });

  useEffect(() => {
    fetch('/api/widgets/rules')
      .then(r => r.ok ? r.json() : [])
      .then(d => setPolicies(d as PolicyOption[]))
      .catch(() => {});
    // Categories/tags/subscriptions/resourceGroups fetched live (DB-backed, user-extensible) —
    // same endpoint the dashboard filter bar uses.
    fetch('/api/widgets/filter-options')
      .then(r => r.ok ? r.json() : null)
      .then((d: FilterOptionsResponse | null) => { if (d) setOptions(d); })
      .catch(() => {});
  }, []);

  if (!local) return null;

  const cfg = local.config;

  function setTitle(v: string) { setLocal(w => w ? { ...w, title: v } : w); }
  function setConfig(key: string, value: unknown) {
    setLocal(w => w ? { ...w, config: { ...w.config, [key]: value } } : w);
  }

  // new-vs-fixed and activity-occurrences are NOT here — finding_events supports rule scoping,
  // so neither has a rule caveat.
  const trendCaveatTypes: WidgetType[] = ['stat-card', 'posture-ring', 'trend'];

  function renderTypeConfig() {
    switch (local!.type) {
      case 'stat-card':
        return (
          <Field label="Metric">
            <Select size="sm" value={String(cfg.metric ?? 'posture-pct')} onValueChange={v => setConfig('metric', v)} options={STAT_METRICS} />
          </Field>
        );
      case 'posture-ring':
        return (
          <Field label="Options">
            <div className="space-y-2">
              <Toggle checked={Boolean(cfg.showDelta)} onChange={v => setConfig('showDelta', v)} label="Show delta vs baseline" />
            </div>
          </Field>
        );
      case 'trend':
        return (
          <>
            <Field label="Time Period">
              <Select size="sm" value={String(cfg.period ?? '30d')} onValueChange={v => setConfig('period', v)} options={PERIODS} />
            </Field>
            <Field label="Chart Type">
              <Select size="sm" value={String(cfg.chartType ?? 'area')} onValueChange={v => setConfig('chartType', v)} options={CHART_TYPES} />
            </Field>
          </>
        );
      case 'new-vs-fixed':
      case 'activity-occurrences':
        return (
          <Field label="Time Period">
            <Select size="sm" value={String(cfg.period ?? '30d')} onValueChange={v => setConfig('period', v)} options={EVENT_PERIODS} />
          </Field>
        );
      case 'recent-findings':
        return (
          <Field label="Max Findings">
            <NumberInput value={Number(cfg.limit ?? 10)} onChange={v => setConfig('limit', v)} min={5} max={100} />
          </Field>
        );
      case 'top-rules':
        return (
          <Field label="Max Rules">
            <NumberInput value={Number(cfg.limit ?? 10)} onChange={v => setConfig('limit', v)} min={3} max={20} />
          </Field>
        );
      case 'top-resources':
        return (
          <Field label="Max Resources">
            <NumberInput value={Number(cfg.limit ?? 10)} onChange={v => setConfig('limit', v)} min={3} max={20} />
          </Field>
        );
      case 'subscription-scorecard':
        return (
          <Field label="Max Subscriptions">
            <NumberInput value={Number(cfg.limit ?? 20)} onChange={v => setConfig('limit', v)} min={3} max={50} />
          </Field>
        );
      case 'coverage-freshness':
        return (
          <Field label="Stale after (hours)">
            <NumberInput value={Number(cfg.staleAfterHours ?? 168)} onChange={v => setConfig('staleAfterHours', v)} min={1} max={720} />
          </Field>
        );
      case 'category-scorecard':
      case 'severity-breakdown':
        return null;
      default:
        return <p className="text-sm text-ink-muted">No configuration available.</p>;
    }
  }

  const typeConfig = renderTypeConfig();

  return (
    <SlideOverPanel
      title="Configure Widget"
      onClose={onClose}
      bodyClassName="flex-1 overflow-y-auto px-4 py-5 space-y-5"
      footer={
        <div className="flex shrink-0 gap-2 border-t border-rule-strong px-4 py-4">
          <Button variant="outline" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button className="flex-1 gap-2" onClick={() => { onSave(local); onClose(); }}>
            <Save className="size-3.5" />Apply
          </Button>
        </div>
      }
    >
      <Field label="Title">
        <TextInput value={local.title} onChange={setTitle} placeholder="Widget title" />
      </Field>

      <div className="h-px bg-border" />

      <ScopeSection
        cfg={cfg}
        setConfig={setConfig}
        categories={options.categories}
        subscriptions={options.subscriptions}
        resourceGroups={options.resourceGroups}
        tags={options.tags}
        policies={policies}
        trendCaveat={trendCaveatTypes.includes(local.type)}
      />

      {typeConfig && (
        <>
          <div className="h-px bg-border" />
          {typeConfig}
        </>
      )}
    </SlideOverPanel>
  );
}
