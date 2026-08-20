'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { SeverityBadge } from '@/components/findings/severity-badge';
import { CategoryBadge } from '@/components/findings/category-badge';
import { FindingsExplorerClient } from '@/components/findings/findings-explorer-client';
import { RunScanButton } from '@/components/scans/run-scan-button';
import { ScanHistoryTab, type ScanHistoryTabProps } from './scan-history-tab';
import { SchedulesTab, type ScheduleWithLastRun } from './schedules-tab';
import type { NotificationChannelSummary } from '@/lib/db/notification-channels';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { ChecklistDropdown } from '@/components/ui/checklist-dropdown';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ToggleChip } from '@/components/ui/toggle-chip';
import { cn } from '@/lib/utils';
import { matchesRuleSearch } from '@/lib/rule-filters';
import { toggleInSet } from '@/lib/toggle-set';
import { splitLearnMore } from '@/lib/rule-description';
import { can, type Role } from '@/lib/rbac';
import type { Category, Rule, Severity } from '@/lib/types';
import type { ExplorerData } from '@/lib/explorer-data';
import {
  ShieldCheck, Library, Search,
} from 'lucide-react';

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const STATUS_OPTIONS = [
  { value: 'all', label: 'All status' },
  { value: 'enabled', label: 'Enabled' },
  { value: 'disabled', label: 'Disabled' },
] as const;
type TabKey = 'results' | 'history' | 'rules' | 'schedules';

/** null for 'success' (the row shows no chip at all) and for a rule that predates spec 030's
 *  columns just as much as one that genuinely never ran — both read back as undefined. */
function ruleStatusLabel(status: Rule['lastRunStatus']): string | null {
  switch (status) {
    case 'failed': return 'query failed';
    case 'capped': return 'result capped';
    case 'invalid': return 'no resource id';
    case 'success': return null;
    default: return 'not yet run';
  }
}

function TabLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cn(
        '-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
        active ? 'border-ink text-ink' : 'border-transparent text-ink-2 hover:text-ink',
      )}
    >
      {children}
    </Link>
  );
}

export interface ScansClientProps {
  policies: Rule[];
  categories: Category[];
  role: Role;
  activeTab: TabKey;
  explorerData: ExplorerData;
  initialSuppressions?: ScanHistoryTabProps['initialSuppressions'];
  initialCategoryFilter?: string[];
  /** Deep-link filters for the Results tab (e.g. from an old `?category=` link, a
   *  "View in Findings" link carrying a ruleId, or a dashboard widget click-through carrying
   *  any combination of these). Forwarded as-is into FindingsExplorerClient's `initialFilters`. */
  resultsInitialFilters?: {
    categories?: string[]; status?: string; ruleId?: string;
    severities?: Severity[]; subscriptions?: string[]; resourceGroups?: string[]; locations?: string[];
    tags?: string[]; windowDays?: number; from?: string; to?: string; search?: string;
  };
  runs?: ScanHistoryTabProps['runs'];
  runDetail?: ScanHistoryTabProps['runDetail'];
  snapshotScan?: ScanHistoryTabProps['snapshotScan'];
  compareCategorySlug?: string;
  compareCategoryScans?: ScanHistoryTabProps['compareCategoryScans'];
  compareScans?: ScanHistoryTabProps['compareScans'];
  /** Undefined when the tab isn't active — server only loads this for ?tab=schedules. */
  initialSchedules?: ScheduleWithLastRun[];
  canEditSchedules?: boolean;
  /** Notification channel list for the Notifications section in the schedule form.
   *  Empty when the user lacks notifications:manage — the section is simply hidden. */
  notificationChannels?: NotificationChannelSummary[];
  /** Active-finding count per rule id, for the Rules tab's "N resources affected" column.
   *  Undefined when the tab isn't active — server only computes this for ?tab=rules. */
  ruleFindingCounts?: Record<string, number>;
}

export function ScansClient({
  policies: initialPolicies,
  categories,
  role,
  activeTab,
  explorerData,
  initialSuppressions,
  initialCategoryFilter,
  resultsInitialFilters,
  runs,
  runDetail,
  snapshotScan,
  compareCategorySlug,
  compareCategoryScans,
  compareScans,
  initialSchedules,
  canEditSchedules = false,
  notificationChannels = [],
  ruleFindingCounts = {},
}: ScansClientProps) {
  const canRunScans = can(role, 'scans:run');
  const canEditRules = can(role, 'rules:write');
  const canSuppress = can(role, 'suppressions:write');
  const [policies, setPolicies] = useState(initialPolicies);

  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  const [severityFilter, setSeverityFilter] = useState<Set<Severity>>(new Set());
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [categoryFilter, setCategoryFilter] = useState<Set<string>>(new Set(initialCategoryFilter ?? []));

  const categoryById = useMemo(() => new Map(categories.map(c => [c.id, c])), [categories]);

  const tagOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of policies) for (const t of p.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([value, count]) => ({ value, label: value, count }));
  }, [policies]);

  const categoryOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of policies) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => (categoryById.get(a[0])?.label ?? a[0]).localeCompare(categoryById.get(b[0])?.label ?? b[0]))
      .map(([value, count]) => ({ value, label: categoryById.get(value)?.label ?? value, count }));
  }, [policies, categoryById]);

  const visible = useMemo(() => policies.filter(p => {
    if (tagFilter.size > 0 && !(p.tags ?? []).some(t => tagFilter.has(t))) return false;
    if (severityFilter.size > 0 && !severityFilter.has(p.severity)) return false;
    if (statusFilter === 'enabled'  && !p.enabled) return false;
    if (statusFilter === 'disabled' &&  p.enabled) return false;
    if (categoryFilter.size > 0 && !categoryFilter.has(p.category)) return false;
    if (!matchesRuleSearch(p, search, categoryById.get(p.category)?.label)) return false;
    return true;
  }), [policies, tagFilter, severityFilter, statusFilter, categoryFilter, search, categoryById]);

  const enabledCount = policies.filter(p => p.enabled).length;
  const hasActiveFilter = search.trim() !== '' || tagFilter.size > 0 || severityFilter.size > 0 || statusFilter !== 'all' || categoryFilter.size > 0;

  async function toggleEnabled(policy: Rule) {
    const updated = { ...policy, enabled: !policy.enabled };
    await fetch(`/api/rules/${encodeURIComponent(policy.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    });
    setPolicies(ps => ps.map(p => p.id === policy.id ? updated : p));
  }

  // Run Scan target defaults to whatever the Rules tab's Category filter currently holds — the
  // most direct expression of "run what I'm looking at" without forcing Results' own (separate,
  // single-select) category tabs to double as a run target too.
  const runDefaults = categoryFilter.size > 0
    ? { targetType: 'categories' as const, targetValues: [...categoryFilter] }
    : { targetType: 'all' as const, targetValues: [] as string[] };

  return (
    <main className="flex-1 p-8 space-y-6">

      {canRunScans && (
        <div className="flex items-center justify-end">
          <RunScanButton
            categories={categories}
            rules={policies}
            defaultTargetType={runDefaults.targetType}
            defaultTargetValues={runDefaults.targetValues}
          />
        </div>
      )}

      {/* Sub-tabs */}
      <div className="flex gap-0 border-b border-border overflow-x-auto overflow-y-hidden">
        <TabLink href="/scans?tab=results" active={activeTab === 'results'}>Results</TabLink>
        <TabLink href="/scans?tab=history" active={activeTab === 'history'}>Run History</TabLink>
        <TabLink href="/scans?tab=rules" active={activeTab === 'rules'}>
          Rules <span className="ml-1 text-xs">({enabledCount}/{policies.length})</span>
        </TabLink>
        <TabLink href="/scans?tab=schedules" active={activeTab === 'schedules'}>Schedules</TabLink>
      </div>

      {activeTab === 'results' && (
        <FindingsExplorerClient
          data={explorerData}
          suppressions={initialSuppressions}
          canSuppress={canSuppress}
          initialFilters={resultsInitialFilters}
          basePath="/scans"
          extraParams={{ tab: 'results' }}
          mode="page"
        />
      )}

      {activeTab === 'history' && (
        <ScanHistoryTab
          categories={categories}
          rules={policies}
          runs={runs ?? []}
          runDetail={runDetail}
          snapshotScan={snapshotScan}
          compareCategorySlug={compareCategorySlug}
          compareCategoryScans={compareCategoryScans}
          compareScans={compareScans}
          initialSuppressions={initialSuppressions}
        />
      )}

      {activeTab === 'rules' && (
        <Card>
          {policies.length === 0 ? (
            <CardContent>
              <div className="flex flex-col items-center justify-center gap-4 py-12 text-center">
                <div className="flex size-12 items-center justify-center border border-border bg-surface-sunken">
                  <ShieldCheck className="size-6 text-ink-faint" />
                </div>
                <div>
                  <p className="text-sm font-medium text-ink">No rules yet</p>
                  <p className="mt-1 text-sm text-ink-muted">Create a rule from the Library to start scanning.</p>
                </div>
                <Link href="/library">
                  <Button size="sm" variant="outline" className="gap-2">
                    <Library className="size-3.5" /> Browse Library
                  </Button>
                </Link>
              </div>
            </CardContent>
          ) : (
            <>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <CardTitle>Rules</CardTitle>
                  <Badge variant="secondary" className="text-xs font-medium">
                    {enabledCount} of {policies.length} enabled
                  </Badge>
                </div>
              </CardHeader>

              {/* Filter bar */}
              <div className="flex items-center gap-2 flex-wrap px-6 py-3 border-b border-border">
                <div className="relative w-64 shrink-0">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted" />
                  <Input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search by name, tag, category, ID…"
                    aria-label="Search rules"
                    className="pl-9"
                  />
                </div>

                <ChecklistDropdown
                  label="Category"
                  options={categoryOptions}
                  selected={categoryFilter}
                  onToggle={v => setCategoryFilter(s => toggleInSet(s, v))}
                  onClear={() => setCategoryFilter(new Set())}
                />

                {tagOptions.length > 0 && (
                  <ChecklistDropdown
                    label="Tags"
                    options={tagOptions}
                    selected={tagFilter}
                    onToggle={v => setTagFilter(s => toggleInSet(s, v))}
                    onClear={() => setTagFilter(new Set())}
                  />
                )}

                <div className="flex shrink-0 items-center gap-1">
                  {SEVERITY_ORDER.map(sev => (
                    <ToggleChip
                      key={sev}
                      selected={severityFilter.has(sev)}
                      onClick={() => setSeverityFilter(s => toggleInSet(s, sev))}
                      className="capitalize"
                    >
                      {sev}
                    </ToggleChip>
                  ))}
                </div>

                {/* The trigger fills its parent by design, so it needs a parent with a width. */}
                <div className="w-36 shrink-0">
                  <Select
                    value={statusFilter}
                    onValueChange={v => setStatusFilter(v as typeof statusFilter)}
                    options={STATUS_OPTIONS}
                    aria-label="Filter by status"
                  />
                </div>

                {hasActiveFilter && (
                  <Button
                    variant="ghost"
                    className="shrink-0"
                    onClick={() => { setSearch(''); setTagFilter(new Set()); setSeverityFilter(new Set()); setStatusFilter('all'); setCategoryFilter(new Set()); }}
                  >
                    Clear
                  </Button>
                )}
              </div>

              {visible.length === 0 ? (
                <CardContent>
                  <p className="py-10 text-center text-sm text-ink-muted">
                    {hasActiveFilter ? 'No rules match your filters' : 'No rules'}
                  </p>
                </CardContent>
              ) : (
                <div className="divide-y divide-border">
                  {visible.map(policy => {
                    const findingCount = ruleFindingCounts[policy.id] ?? 0;
                    const statusLabel = ruleStatusLabel(policy.lastRunStatus);
                    return (
                      <div
                        key={policy.id}
                        className={cn(
                          'flex items-center gap-4 px-6 py-4 transition-colors hover:bg-surface-hover',
                          !policy.enabled && 'opacity-60',
                        )}
                      >
                        <Switch
                          checked={policy.enabled}
                          disabled={!canEditRules}
                          onCheckedChange={() => { void toggleEnabled(policy); }}
                          title={canEditRules ? (policy.enabled ? 'Disable rule' : 'Enable rule') : 'Read-only access'}
                        />

                        <Link href={`/rules/${encodeURIComponent(policy.id)}`} className="flex-1 min-w-0 group">
                          <p className="text-sm font-medium text-ink underline-offset-4 group-hover:underline">{policy.name}</p>
                          {policy.description && (
                            <p className="mt-0.5 truncate text-xs text-ink-2">{splitLearnMore(policy.description).text}</p>
                          )}
                        </Link>

                        <CategoryBadge id={policy.category} categories={categories} />

                        <SeverityBadge severity={policy.severity} />

                        {policy.lastPopulationCount !== undefined ? (
                          <span className="numeral-grid shrink-0 text-xs text-ink-muted">
                            {findingCount} of {policy.lastPopulationCount} affected
                          </span>
                        ) : findingCount > 0 && (
                          <span className="numeral-grid shrink-0 text-xs text-ink-muted">
                            {findingCount} resource{findingCount === 1 ? '' : 's'} affected
                          </span>
                        )}

                        {statusLabel && (
                          <span className="inline-flex w-fit shrink-0 items-center gap-1 bg-surface-sunken px-1.5 py-0.5 text-xs font-medium text-ink-2">
                            {statusLabel}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {activeTab === 'schedules' && (
        <SchedulesTab
          initialSchedules={initialSchedules ?? []}
          categories={categories}
          rules={policies}
          channels={notificationChannels}
          canEdit={canEditSchedules}
        />
      )}

    </main>
  );
}
