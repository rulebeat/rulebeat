'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
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
import { Callout } from '@/components/ui/callout';
import { Switch } from '@/components/ui/switch';
import { ChecklistDropdown } from '@/components/ui/checklist-dropdown';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ToggleChip } from '@/components/ui/toggle-chip';
import { cn } from '@/lib/utils';
import { applyRuleToggle, requestRuleToggle } from '@/lib/rule-toggle';
import {
  bulkChanges, headerCheckboxState, pruneSelection, toggleAllVisible, type BulkAction,
} from '@/lib/rule-bulk-selection';
import { applyBulkToggle, bulkToggleMessage, requestBulkToggle, rulesPhrase } from '@/lib/rule-bulk-toggle';
import { toggleInSet } from '@/lib/toggle-set';
import { splitLearnMore } from '@/lib/rule-description';
import { OUTCOME_DESCRIPTION, OUTCOME_LABEL, RULE_OUTCOMES } from '@/lib/rule-outcome';
import type { RulesTabList } from '@/lib/rules-tab-list';
import {
  EMPTY_RULES_QUERY, RULES_KINDS, hasRulesFilter, rulesQueryToSearchParams, type RulesTabQuery,
} from '@/lib/rules-tab-query';
import { shownRules } from '@/lib/rules-tab-view';
import { can, type Role } from '@/lib/rbac';
import type { WriteControls } from '@/lib/write-controls';
import type { Category, Rule, Severity, Suppression } from '@/lib/types';
import type { View } from '@/lib/finding-view';
import type { SavedView, SavedViewTab } from '@/lib/saved-view-query';
import { savedViewHref } from '@/lib/saved-view-query';
import { OwnUrlWrites } from '@/lib/own-url-writes';
import { KIND_DESCRIPTION, KIND_LABEL } from '@/lib/finding-kinds';
import type { TabEmptyState } from '@/lib/tab-empty-state';
import {
  ShieldCheck, Library, Search,
} from 'lucide-react';

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const STATUS_OPTIONS = [
  { value: 'all', label: 'All status' },
  { value: 'enabled', label: 'Enabled' },
  { value: 'disabled', label: 'Disabled' },
] as const;
const KIND_OPTIONS = [
  { value: 'all', label: 'All kinds' },
  ...RULES_KINDS.map(kind => ({ value: kind, label: kind === 'problem' ? 'Problems' : kind === 'advisory' ? 'Advisories' : 'Activity' })),
];
const OUTCOME_OPTIONS = [
  { value: 'all', label: 'All outcomes' },
  ...RULE_OUTCOMES.map(outcome => ({ value: outcome, label: OUTCOME_LABEL[outcome] })),
];
const toggleIn = <T extends string>(list: readonly T[], value: T): T[] => (list.includes(value) ? list.filter(v => v !== value) : [...list, value]);

/** Who the Outcome column is read for, in the words the line above the list uses. */
function outcomeScopeText(scope: RulesTabList['scope']): string {
  if (scope.kind === 'everything') return 'Everything';
  if (scope.kind === 'access') return scope.count === 1 ? 'the Scope you hold' : `the ${scope.count} Scopes you hold`;
  return scope.count === 1 ? 'the Scope in the address' : `the ${scope.count} Scopes in the address`;
}
type TabKey = 'results' | 'advisories' | 'activity' | 'history' | 'rules' | 'schedules';

/** null for 'success' (the row shows no chip at all) and for a rule that predates spec 030's
 *  columns just as much as one that genuinely never ran. Both read back as undefined. */
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
  initialSuppressions?: Suppression[];
  /** The view the Results and Advisories tabs open on, read from the URL by `viewFromSearchParams`
   *  (e.g. an old `?category=` link, a "View in Findings" link carrying a ruleId, a dashboard widget
   *  click-through, or a saved link with columns, sort and row filters). Forwarded as-is into
   *  FindingsExplorerClient's `initialView`. The page sends no findings: the explorer reads them. */
  initialView?: View;
  /** Which saved view the URL says is open (`?view=`). Undefined when none is. */
  initialSavedViewId?: string;
  runs?: ScanHistoryTabProps['runs'];
  runDetail?: ScanHistoryTabProps['runDetail'];
  /** The scan a `?scan=` link names, with what the address asks of it. The page sends no findings: the
   *  snapshot screen reads them from the server. */
  snapshotScanId?: ScanHistoryTabProps['snapshotScanId'];
  snapshotQuery?: ScanHistoryTabProps['snapshotQuery'];
  compareCategorySlug?: string;
  compareCategoryScans?: ScanHistoryTabProps['compareCategoryScans'];
  /** The two scans a `?compare=` link names, with what the address asks of them. The page sends no
   *  findings: the compare screen reads them from the server. */
  compareIds?: ScanHistoryTabProps['compareIds'];
  compareQuery?: ScanHistoryTabProps['compareQuery'];
  /** Undefined when the tab isn't active: server only loads this for ?tab=schedules. */
  initialSchedules?: ScheduleWithLastRun[];
  /** The library, schedule and suppression controls the person gets, from `writeControlsFor` on the server.
   *  Without it the Role alone decides, as it did before Scopes. */
  controls?: WriteControls;
  /** Notification channel list for the Notifications section in the schedule form.
   *  Empty when the user lacks notifications:manage. The section is simply hidden. */
  notificationChannels?: NotificationChannelSummary[];
  /** The person holds no Scope: the Results, Advisories and Activity tabs say so instead of "No findings yet". */
  noAccess?: boolean;
  /** The Rules tab's filters as the address holds them, read by `rulesQueryFromSearchParams`. */
  rulesQuery?: RulesTabQuery;
  /** The rules the address lists, each with its Outcome at the Scope it names and its "N resources affected".
   *  Undefined when the tab isn't active: the server only computes this for ?tab=rules. */
  ruleList?: RulesTabList;
  /** Why the Advisories or Activity tab is empty. Undefined on every other tab. */
  tabEmpty?: TabEmptyState;
}

export function ScansClient({
  policies: initialPolicies,
  categories,
  role,
  activeTab,
  initialSuppressions,
  initialView,
  initialSavedViewId,
  runs,
  runDetail,
  snapshotScanId,
  snapshotQuery,
  compareCategorySlug,
  compareCategoryScans,
  compareIds,
  compareQuery,
  initialSchedules,
  controls,
  notificationChannels = [],
  rulesQuery = EMPTY_RULES_QUERY,
  ruleList,
  tabEmpty,
  noAccess,
}: ScansClientProps) {
  const router = useRouter();
  const searchString = useSearchParams().toString();
  const canRunScans = can(role, 'scans:run');
  const canEditRules = controls ? controls.rulesWrite : can(role, 'rules:write');
  // Same action as deleting a rule: clearing its findings reaches the same primitive that rule
  // deletion already does, so it is not an escalation for anyone who holds rules:delete.
  const canClearFindings = controls ? controls.rulesDelete : can(role, 'rules:delete');
  const canSuppress = controls ? controls.suppress : can(role, 'suppressions:write');
  const canEditSchedules = controls ? controls.schedulesWrite : can(role, 'schedules:write');
  // Set only for someone whose Editor access covers part of the install: their write controls are shown
  // off with this reason instead of failing with a 403 on click.
  const writeOffReason = controls?.reason;
  const rulesOffReason = canEditRules ? undefined : writeOffReason;
  const clearOffReason = canClearFindings ? undefined : writeOffReason;
  const canWriteViews = can(role, 'views:write');

  // The explorer reads its initial view once and then writes every change back to the URL. So when
  // the URL changes by anything other than one of its own writes (a saved view opened from the
  // menu, a Back or Forward, a link from another page), it starts again from the new URL. The key
  // only counts those restarts; what the explorer shows always comes from the URL.
  const [ownWrites] = useState(() => new OwnUrlWrites(searchString));
  const [explorerKey, setExplorerKey] = useState(0);
  // Counts finished scans, so the explorer reads its view again rather than the page being reloaded.
  const [scansFinished, setScansFinished] = useState(0);
  const explorerTab = activeTab === 'results' || activeTab === 'advisories' || activeTab === 'activity' ? activeTab : null;
  const showsExplorer = explorerTab !== null;
  useEffect(() => {
    if (!ownWrites.isOutside(searchString)) return;
    // Restarting the explorer for a navigation it did not make, not state derived from props.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExplorerKey(k => k + 1);
  }, [searchString, ownWrites]);
  const savedViewsFor = (tab: SavedViewTab) => ({
    tab,
    canWrite: canWriteViews,
    openId: initialSavedViewId ?? null,
    onOpen: (saved: SavedView) => {
      ownWrites.forget();
      router.push(savedViewHref(saved));
    },
    onUrlWrite: (query: string) => ownWrites.record(query),
  });
  const [policies, setPolicies] = useState(initialPolicies);
  const [clearingId, setClearingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const [search, setSearch] = useState('');
  const [listing, startListing] = useTransition();
  const categoryFilter = useMemo(() => new Set(rulesQuery.categories), [rulesQuery.categories]);
  const tagFilter = useMemo(() => new Set(rulesQuery.tags), [rulesQuery.tags]);

  /** The Rules tab's filters live in the address and the server lists the rules, so a control writes the
   *  address and the page reads it again. The params the page owns, and the Scope, are kept. */
  function writeRulesQuery(next: RulesTabQuery) {
    const written = rulesQueryToSearchParams(next, new URLSearchParams(searchString)).toString();
    ownWrites.record(written);
    startListing(() => { router.replace(`/scans?${written}`); });
  }
  const patchRulesQuery = (patch: Partial<RulesTabQuery>) => writeRulesQuery({ ...rulesQuery, ...patch });

  const explorerCategories = useMemo(() => categories.map(c => ({ id: c.id, label: c.label, color: c.color })), [categories]);
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

  // The server's list narrowed by free-text search, the one filter that stays in the browser.
  const shown = useMemo(
    () => shownRules(ruleList?.entries ?? [], policies, search, category => categoryById.get(category)?.label),
    [ruleList, policies, search, categoryById],
  );
  const visible = useMemo(() => shown.map(s => s.policy), [shown]);

  // A rule the list hides leaves the selection for good, so widening the filters again cannot
  // bring it back into a bulk action unseen. Syncing to the server's list, not derivable state.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setSelection(s => pruneSelection(s, visible)); }, [visible]);
  // Also pruned at render, for the one pass before the effect above has run.
  const selected = pruneSelection(selection, visible);
  const changes = bulkChanges(selected, visible);
  const headerState = headerCheckboxState(selected, visible);

  const enabledCount = policies.filter(p => p.enabled).length;
  const hasActiveFilter = search.trim() !== '' || hasRulesFilter(rulesQuery);

  async function toggleEnabled(policy: Rule) {
    setNotice(null);
    const outcome = await requestRuleToggle(policy);
    setPolicies(ps => applyRuleToggle(ps, outcome));
    if (!outcome.ok) setNotice({ tone: 'error', text: outcome.error });
    // The server decides what is listed and each rule's Outcome, so it is asked again.
    else router.refresh();
  }

  /** Sends only the selected rules this action changes. The selection clears on success and stays
   *  on failure, so the same action can be tried again. */
  async function bulkToggle(action: BulkAction) {
    const ids = changes[action];
    if (ids.length === 0) return;
    setNotice(null);
    setBulkBusy(true);
    try {
      const outcome = await requestBulkToggle(action, ids);
      setPolicies(ps => applyBulkToggle(ps, outcome));
      if (outcome.ok) {
        setSelection(new Set());
        setNotice({ tone: 'success', text: bulkToggleMessage(outcome) });
        router.refresh();
      } else {
        setNotice({ tone: 'error', text: outcome.error });
      }
    } finally {
      setBulkBusy(false);
    }
  }

  /** Deletes every finding the rule produced, active and fixed, and keeps the rule (issue #98).
   *  The count in the row is active findings only, so the number reported back from the server
   *  can be higher; the copy says "findings", never "active findings", for that reason. After a
   *  success the server's own per-rule counts are re-read via router.refresh() rather than patched
   *  locally, so the row cannot drift from what the page would show on a fresh load. */
  async function clearFindings(policy: Rule) {
    const lines = [
      `Clear every finding for "${policy.name}"?`,
      'This deletes the rule\'s findings and their history and cannot be undone. The rule itself stays, and any suppressions are kept.',
    ];
    if (policy.enabled) {
      lines.push('This rule is still enabled: the next scan that runs it recreates whatever still matches and notifies about each one as new. Disable the rule first if that is not what you want.');
    }
    if (!confirm(lines.join('\n\n'))) return;

    setNotice(null);
    setClearingId(policy.id);
    try {
      const res = await fetch(`/api/rules/${encodeURIComponent(policy.id)}/findings`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setNotice({ tone: 'error', text: body.error ?? `Could not clear the findings for "${policy.name}".` });
        return;
      }
      const { deleted } = await res.json() as { deleted: number };
      setNotice({ tone: 'success', text: `Cleared ${deleted} finding${deleted === 1 ? '' : 's'} for "${policy.name}".` });
      router.refresh();
    } catch {
      setNotice({ tone: 'error', text: `Could not clear the findings for "${policy.name}".` });
    } finally {
      setClearingId(null);
    }
  }

  // Run Scan target defaults to whatever the Rules tab's Category filter currently holds. The
  // most direct expression of "run what I'm looking at" without forcing Results' own (separate,
  // single-select) category tabs to double as a run target too.
  const runDefaults = rulesQuery.categories.length > 0
    ? { targetType: 'categories' as const, targetValues: rulesQuery.categories }
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
            onScanFinished={showsExplorer ? () => setScansFinished(n => n + 1) : undefined}
          />
        </div>
      )}

      {/* Sub-tabs */}
      <div className="flex gap-0 border-b border-border overflow-x-auto overflow-y-hidden">
        <TabLink href="/scans?tab=results" active={activeTab === 'results'}>Results</TabLink>
        <TabLink href="/scans?tab=advisories" active={activeTab === 'advisories'}>Advisories</TabLink>
        <TabLink href="/scans?tab=activity" active={activeTab === 'activity'}>Activity</TabLink>
        <TabLink href="/scans?tab=history" active={activeTab === 'history'}>Run History</TabLink>
        <TabLink href="/scans?tab=rules" active={activeTab === 'rules'}>
          Rules <span className="ml-1 text-xs">({enabledCount}/{policies.length})</span>
        </TabLink>
        <TabLink href="/scans?tab=schedules" active={activeTab === 'schedules'}>Schedules</TabLink>
      </div>

      {explorerTab && (
        <FindingsExplorerClient
          key={`${explorerTab}-${explorerKey}`}
          tab={explorerTab}
          categories={explorerCategories}
          scansFinished={scansFinished}
          suppressions={initialSuppressions}
          canSuppress={canSuppress}
          initialView={initialView}
          basePath="/scans"
          extraParams={{ tab: explorerTab }}
          mode="page"
          savedViews={savedViewsFor(explorerTab)}
          hideRuleView={explorerTab === 'advisories'}
          emptyTitle={tabEmpty?.title}
          emptyHint={tabEmpty?.hint}
          noAccess={noAccess}
        />
      )}

      {activeTab === 'history' && (
        <ScanHistoryTab
          categories={categories}
          rules={policies}
          runs={runs ?? []}
          runDetail={runDetail}
          snapshotScanId={snapshotScanId}
          snapshotQuery={snapshotQuery}
          snapshotRestarts={explorerKey}
          onSnapshotUrlWrite={query => ownWrites.record(query)}
          compareCategorySlug={compareCategorySlug}
          compareCategoryScans={compareCategoryScans}
          compareIds={compareIds}
          compareQuery={compareQuery}
          compareRestarts={explorerKey}
          onCompareUrlWrite={query => ownWrites.record(query)}
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
                  onToggle={v => patchRulesQuery({ categories: toggleIn(rulesQuery.categories, v) })}
                  onClear={() => patchRulesQuery({ categories: [] })}
                />

                {tagOptions.length > 0 && (
                  <ChecklistDropdown
                    label="Tags"
                    options={tagOptions}
                    selected={tagFilter}
                    onToggle={v => patchRulesQuery({ tags: toggleIn(rulesQuery.tags, v) })}
                    onClear={() => patchRulesQuery({ tags: [] })}
                  />
                )}

                <div className="flex shrink-0 items-center gap-1">
                  {SEVERITY_ORDER.map(sev => (
                    <ToggleChip
                      key={sev}
                      selected={rulesQuery.severities.includes(sev)}
                      onClick={() => patchRulesQuery({ severities: toggleIn(rulesQuery.severities, sev) })}
                      className="capitalize"
                    >
                      {sev}
                    </ToggleChip>
                  ))}
                </div>

                {/* The trigger fills its parent by design, so it needs a parent with a width. */}
                <div className="w-36 shrink-0">
                  <Select
                    value={rulesQuery.rules}
                    onValueChange={v => patchRulesQuery({ rules: v as RulesTabQuery['rules'] })}
                    options={STATUS_OPTIONS}
                    aria-label="Filter by status"
                  />
                </div>

                <div className="w-36 shrink-0">
                  <Select
                    value={rulesQuery.kind ?? 'all'}
                    onValueChange={v => patchRulesQuery({ kind: v === 'all' ? undefined : v as RulesTabQuery['kind'] })}
                    options={KIND_OPTIONS}
                    aria-label="Filter by kind"
                  />
                </div>

                <div className="w-36 shrink-0">
                  <Select
                    value={rulesQuery.outcome ?? 'all'}
                    onValueChange={v => patchRulesQuery({ outcome: v === 'all' ? undefined : v as RulesTabQuery['outcome'] })}
                    options={OUTCOME_OPTIONS}
                    aria-label="Filter by outcome"
                  />
                </div>

                {hasActiveFilter && (
                  <Button
                    variant="ghost"
                    className="shrink-0"
                    onClick={() => {
                      setSearch('');
                      // The Scope sets where the Outcome is read and hides no rule, so Clear keeps it.
                      writeRulesQuery({ ...EMPTY_RULES_QUERY, subscriptions: rulesQuery.subscriptions, resourceGroups: rulesQuery.resourceGroups, managementGroups: rulesQuery.managementGroups });
                    }}
                  >
                    Clear
                  </Button>
                )}
              </div>

              {ruleList && (
                <p className="px-6 pt-3 text-xs text-ink-2">
                  Outcome is read for {outcomeScopeText(ruleList.scope)}.
                </p>
              )}

              {notice && (
                <div className="px-6 pt-4">
                  <Callout tone={notice.tone}>{notice.text}</Callout>
                </div>
              )}

              {visible.length === 0 ? (
                <CardContent>
                  <p className="py-10 text-center text-sm text-ink-muted">
                    {rulesQuery.outcome && rulesQuery.rules === 'disabled'
                      ? 'A disabled rule has no outcome, so no rule matches this outcome filter'
                      : hasActiveFilter ? 'No rules match your filters' : 'No rules'}
                  </p>
                </CardContent>
              ) : (
                <div className="divide-y divide-border" aria-busy={listing}>
                  {/* Select-all row, and the action bar once anything is selected. Normal page
                      flow, not sticky: the page has one scroll region. */}
                  {(canEditRules || rulesOffReason) && (
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3">
                      <input
                        type="checkbox"
                        id="rules-select-all"
                        checked={headerState === 'all'}
                        disabled={bulkBusy || !canEditRules}
                        title={rulesOffReason}
                        ref={el => { if (el) el.indeterminate = headerState === 'some'; }}
                        onChange={() => setSelection(s => toggleAllVisible(pruneSelection(s, visible), visible))}
                        aria-label={headerState === 'all' ? 'Clear selection' : `Select all ${rulesPhrase(visible.length)} shown`}
                        className="size-3.5 shrink-0 accent-ink"
                      />
                      {selected.size === 0 ? (
                        <label htmlFor="rules-select-all" className="cursor-pointer text-sm text-ink-2">
                          Select all {rulesPhrase(visible.length)} shown
                        </label>
                      ) : (
                        <>
                          <span className="numeral-grid text-sm font-medium text-ink">{selected.size} selected</span>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={bulkBusy || changes.enable.length === 0}
                              onClick={() => { void bulkToggle('enable'); }}
                            >
                              Enable {rulesPhrase(changes.enable.length)}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={bulkBusy || changes.disable.length === 0}
                              onClick={() => { void bulkToggle('disable'); }}
                            >
                              Disable {rulesPhrase(changes.disable.length)}
                            </Button>
                            <Button size="sm" variant="ghost" disabled={bulkBusy} onClick={() => setSelection(new Set())}>
                              Clear selection
                            </Button>
                          </div>
                        </>
                      )}
                      {rulesOffReason && (
                        <>
                          <Button size="sm" variant="outline" disabled title={rulesOffReason}>Enable</Button>
                          <Button size="sm" variant="outline" disabled title={rulesOffReason}>Disable</Button>
                          <span className="text-xs text-ink-2">{rulesOffReason}</span>
                        </>
                      )}
                    </div>
                  )}
                  {shown.map(({ policy, entry }) => {
                    const findingCount = entry.findingCount;
                    // A rule switched off here has no outcome until the server reads the list again.
                    const outcome = policy.enabled ? entry.outcome : null;
                    const statusLabel = ruleStatusLabel(policy.lastRunStatus);
                    return (
                      <div
                        key={policy.id}
                        className={cn(
                          'flex items-center gap-4 px-6 py-4 transition-colors hover:bg-surface-hover',
                          !policy.enabled && 'opacity-60',
                        )}
                      >
                        {(canEditRules || rulesOffReason) && (
                          <input
                            type="checkbox"
                            checked={selected.has(policy.id)}
                            disabled={bulkBusy || !canEditRules}
                            title={rulesOffReason}
                            onChange={() => setSelection(s => toggleInSet(pruneSelection(s, visible), policy.id))}
                            aria-label={`Select ${policy.name}`}
                            className="size-3.5 shrink-0 accent-ink"
                          />
                        )}

                        <Switch
                          checked={policy.enabled}
                          disabled={!canEditRules}
                          onCheckedChange={() => { void toggleEnabled(policy); }}
                          title={canEditRules ? (policy.enabled ? 'Disable rule' : 'Enable rule') : (rulesOffReason ?? 'Read-only access')}
                        />

                        <Link href={`/rules/${encodeURIComponent(policy.id)}`} className="flex-1 min-w-0 group">
                          <p className="text-sm font-medium text-ink underline-offset-4 group-hover:underline">{policy.name}</p>
                          {policy.description && (
                            <p className="mt-0.5 truncate text-xs text-ink-2">{splitLearnMore(policy.description).text}</p>
                          )}
                        </Link>

                        <CategoryBadge id={policy.category} categories={categories} />

                        <SeverityBadge severity={policy.severity} />

                        <span
                          className="inline-flex w-fit shrink-0 items-center bg-surface-sunken px-1.5 py-0.5 text-xs font-medium text-ink-2"
                          title={KIND_DESCRIPTION[policy.kind ?? 'state']}
                        >
                          {KIND_LABEL[policy.kind ?? 'state']}
                        </span>

                        {findingCount > 0 && (
                          <span className="numeral-grid shrink-0 text-xs text-ink-muted">
                            {findingCount} resource{findingCount === 1 ? '' : 's'} affected
                          </span>
                        )}

                        {outcome && (
                          // Red text on the sunken chip is 4.04:1 in the light theme, under 4.5:1 at
                          // 12px, so Failing carries its red as a swatch and keeps the chip's ink.
                          <span
                            className="inline-flex w-fit shrink-0 items-center gap-1.5 bg-surface-sunken px-1.5 py-0.5 text-xs font-medium text-ink-2"
                            title={OUTCOME_DESCRIPTION[outcome]}
                          >
                            {outcome === 'failing' && <span className="h-2 w-2 shrink-0 bg-destructive" aria-hidden="true" />}
                            {OUTCOME_LABEL[outcome]}
                          </span>
                        )}

                        {statusLabel && (
                          <span className="inline-flex w-fit shrink-0 items-center gap-1 bg-surface-sunken px-1.5 py-0.5 text-xs font-medium text-ink-2">
                            {statusLabel}
                          </span>
                        )}

                        {/* Only where there is something to clear: the affected count is what
                            prompts the operator to act, and a row with no findings would just
                            carry a button that does nothing. */}
                        {(canClearFindings || clearOffReason) && findingCount > 0 && (
                          <Button
                            size="xs"
                            variant="ghost"
                            className="shrink-0"
                            disabled={clearingId === policy.id || !canClearFindings}
                            onClick={() => { void clearFindings(policy); }}
                            title={clearOffReason ?? 'Delete every finding this rule produced, active and fixed. The rule stays.'}
                          >
                            {clearingId === policy.id ? 'Clearing…' : 'Clear findings'}
                          </Button>
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
          disabledReason={canEditSchedules ? undefined : writeOffReason}
        />
      )}

    </main>
  );
}
