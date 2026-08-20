'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Play, Save, GitBranch } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Callout } from '@/components/ui/callout';
import { Input, Label, Textarea } from '@/components/ui/input';
import { Select, type SelectOption } from '@/components/ui/select';
import { FieldCombobox } from '@/components/rules/field-combobox';
import { ResourceTypeInput } from '@/components/rules/resource-type-input';
import { ScopeTreePicker } from '@/components/rules/scope-tree-picker';
import { GraphRuleEditor } from '@/components/rules/graph-rule-editor';
import { VisualQueryBuilder, defaultVisualQuery } from '@/components/rules/visual-query-builder';
import { buildQueryFromVisual, parseKqlToVisualQuery } from '@/lib/kql';
import type { VisualQuery } from '@/lib/kql';
import { ResultTable } from '@/components/query/result-table';
import { QueryExportButton } from '@/components/query/query-export-button';
import { SaveQueryDialog } from '@/components/query/save-query-dialog';
import { buildRuleFromQuery } from '@/lib/query-to-rule';
import type {
  GraphQuery, LogAnalyticsQuery, QueryBackend, QueryRun, QueryVisibility, RuleScope, SavedQuery,
} from '@/lib/types';

const ARG_BASE_FIELDS = ['subscriptionId', 'resourceGroup', 'id', 'name', 'type', 'location', 'tags', 'kind', 'sku'];

const CONTAINER_FIELDS: Record<string, string[]> = {
  resourceGroup: [
    'id', 'name', 'type', 'location', 'subscriptionId', 'tenantId', 'tags', 'managedBy',
    'properties.provisioningState',
  ],
  subscription: [
    'id', 'name', 'type', 'subscriptionId', 'tenantId', 'tags',
    'properties.displayName', 'properties.state', 'properties.authorizationSource',
    'properties.managedByTenants',
    'properties.subscriptionPolicies.quotaId', 'properties.subscriptionPolicies.spendingLimit',
  ],
  managementGroup: [
    'id', 'name', 'type', 'tenantId',
    'properties.displayName', 'properties.tenantId',
    'properties.details.parent.id', 'properties.details.parent.name', 'properties.details.parent.displayName',
    'properties.details.updatedTime', 'properties.details.updatedBy', 'properties.details.version',
  ],
};

const ARG_TABLE_OPTIONS: readonly SelectOption[] = [
  { value: 'resource',        label: 'Resources' },
  { value: 'resourceGroup',   label: 'Resource Groups' },
  { value: 'subscription',    label: 'Subscriptions' },
  { value: 'managementGroup', label: 'Management Groups' },
];

// Log Analytics is paused here (spec 038) pending multi-workspace targeting and a GUI builder —
// it only supports one tenant-wide workspace today. RUN_URL and the backend-keyed branches below
// keep their 'log-analytics' cases; they're just unreachable while it's absent from this list.
const BACKEND_OPTIONS: { value: QueryBackend; label: string }[] = [
  { value: 'resource-graph',  label: 'Resource Graph' },
  { value: 'microsoft-graph', label: 'Microsoft Graph' },
];

const RUN_URL: Record<QueryBackend, string> = {
  'resource-graph':  '/api/query/run-resource-graph',
  'microsoft-graph': '/api/query/run-microsoft-graph',
  'log-analytics':   '/api/query/run-log-analytics',
};

const QUERY_PREFILL_KEY = 'rulebeat:query-prefill';

function parseCsv(text: string): string[] {
  return text.split(',').map(s => s.trim()).filter(Boolean);
}

function fieldsForScope(level: RuleScope['level']): string[] {
  const container = CONTAINER_FIELDS[level];
  return container ? [...ARG_BASE_FIELDS, ...container] : ARG_BASE_FIELDS;
}

interface RunResult { count: number; capped: boolean; truncated: boolean; rows: Record<string, unknown>[] }

interface QuerySnapshot {
  backend: QueryBackend;
  scope?: RuleScope;
  visualQuery?: VisualQuery;
  rawKql?: string;
  graphQuery?: GraphQuery;
  logsQuery?: LogAnalyticsQuery;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function QueryPageClient({ defaultCategoryId }: { defaultCategoryId: string }) {
  const router = useRouter();

  const [backend, setBackend] = useState<QueryBackend>('resource-graph');

  // Resource Graph state
  const [scopeLevel, setScopeLevel] = useState<RuleScope['level']>('resource');
  const [scopeSubscriptions, setScopeSubscriptions] = useState<string[]>([]);
  const [scopeManagementGroups, setScopeManagementGroups] = useState<string[]>([]);
  const [resourceTypesText, setResourceTypesText] = useState('*');
  const [projectColumnsText, setProjectColumnsText] = useState('');
  const [columnDraft, setColumnDraft] = useState('');
  const [visualQuery, setVisualQuery] = useState<VisualQuery>(() => defaultVisualQuery());
  const [argKql, setArgKql] = useState('');
  const argKqlDriver = useRef<'visual' | 'kql'>('visual');

  // Microsoft Graph state
  const [graphQuery, setGraphQuery] = useState<GraphQuery>({ path: 'users' });

  // Log Analytics state
  const [logsKql, setLogsKql] = useState('');

  // Shared run/save state
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [loadedSavedQueryId, setLoadedSavedQueryId] = useState<string | undefined>(undefined);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);

  // Saved queries + history side panel
  const [sidePanel, setSidePanel] = useState<'saved' | 'history'>('saved');
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);
  const [savedLoading, setSavedLoading] = useState(true);
  const [savedError, setSavedError] = useState(false);
  const [history, setHistory] = useState<QueryRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState(false);

  useEffect(() => {
    fetchHistory();
    fetchSavedQueries();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchSavedQueries() {
    setSavedLoading(true);
    setSavedError(false);
    try {
      const res = await fetch('/api/query/saved');
      if (!res.ok) { setSavedError(true); return; }
      setSavedQueries(await res.json() as SavedQuery[]);
    } catch {
      setSavedError(true);
    } finally {
      setSavedLoading(false);
    }
  }

  async function fetchHistory() {
    setHistoryLoading(true);
    setHistoryError(false);
    try {
      const res = await fetch('/api/query/runs');
      if (!res.ok) { setHistoryError(true); return; }
      setHistory(await res.json() as QueryRun[]);
    } catch {
      setHistoryError(true);
    } finally {
      setHistoryLoading(false);
    }
  }

  // Visual builder / scope / resource types → KQL. Skipped while the KQL pane itself is the
  // active driver, so a hand-typed query is never clobbered mid-edit by its own parse result.
  useEffect(() => {
    if (argKqlDriver.current === 'kql') return;
    const scope: RuleScope = {
      level: scopeLevel,
      ...(scopeSubscriptions.length ? { subscriptions: scopeSubscriptions } : {}),
      ...(scopeManagementGroups.length ? { managementGroups: scopeManagementGroups } : {}),
    };
    setArgKql(buildQueryFromVisual(visualQuery, {
      scope,
      resourceTypes: parseCsv(resourceTypesText),
      projectColumns: parseCsv(projectColumnsText),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visualQuery, scopeLevel, scopeSubscriptions, scopeManagementGroups, resourceTypesText, projectColumnsText]);

  // KQL → visual builder, debounced, only while the KQL pane is the active driver.
  useEffect(() => {
    if (argKqlDriver.current !== 'kql') return;
    const t = setTimeout(() => {
      const parsed = parseKqlToVisualQuery(argKql);
      setVisualQuery(parsed.visualQuery);
      setScopeLevel(parsed.scope.level);
      setScopeSubscriptions(parsed.scope.subscriptions ?? []);
      setScopeManagementGroups(parsed.scope.managementGroups ?? []);
      setResourceTypesText(parsed.resourceTypes.length ? parsed.resourceTypes.join(', ') : '*');
      setProjectColumnsText(parsed.projectColumns.join(', '));
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [argKql]);

  function updateVisualQuery(next: VisualQuery) {
    argKqlDriver.current = 'visual';
    setVisualQuery(next);
  }
  function updateScopeLevel(level: RuleScope['level']) {
    argKqlDriver.current = 'visual';
    setScopeLevel(level);
    if (level !== 'resource') setResourceTypesText('*');
  }
  function updateScope(next: { subscriptions: string[]; managementGroups: string[] }) {
    argKqlDriver.current = 'visual';
    setScopeSubscriptions(next.subscriptions);
    setScopeManagementGroups(next.managementGroups);
  }
  function updateResourceTypes(text: string) {
    argKqlDriver.current = 'visual';
    setResourceTypesText(text);
  }
  function updateProjectColumns(text: string) {
    argKqlDriver.current = 'visual';
    setProjectColumnsText(text);
  }
  function updateArgKql(text: string) {
    argKqlDriver.current = 'kql';
    setArgKql(text);
  }

  function switchBackend(next: QueryBackend) {
    setBackend(next);
    setResult(null);
    setRunError(null);
    setLoadedSavedQueryId(undefined);
  }

  function currentSnapshot(): QuerySnapshot {
    if (backend === 'resource-graph') {
      return {
        backend,
        scope: {
          level: scopeLevel,
          ...(scopeSubscriptions.length ? { subscriptions: scopeSubscriptions } : {}),
          ...(scopeManagementGroups.length ? { managementGroups: scopeManagementGroups } : {}),
        },
        visualQuery,
        rawKql: argKql,
      };
    }
    if (backend === 'microsoft-graph') return { backend, graphQuery };
    return { backend, logsQuery: { kql: logsKql, timeWindowDays: 30 } };
  }

  function loadSnapshot(snapshot: QuerySnapshot) {
    setBackend(snapshot.backend);
    setResult(null);
    setRunError(null);
    if (snapshot.backend === 'resource-graph') {
      argKqlDriver.current = 'kql';
      setArgKql(snapshot.rawKql ?? '');
    } else if (snapshot.backend === 'microsoft-graph' && snapshot.graphQuery) {
      setGraphQuery(snapshot.graphQuery);
    } else if (snapshot.backend === 'log-analytics' && snapshot.logsQuery) {
      setLogsKql(snapshot.logsQuery.kql);
    }
  }

  async function runQuery() {
    setRunning(true);
    setRunError(null);
    setResult(null);
    try {
      const body: Record<string, unknown> = { savedQueryId: loadedSavedQueryId };
      if (backend === 'resource-graph') {
        if (!argKql.trim()) { setRunError('Write a query first.'); return; }
        body.kql = argKql;
        body.scope = currentSnapshot().scope;
      } else if (backend === 'microsoft-graph') {
        body.graphQuery = graphQuery;
      } else {
        if (!logsKql.trim()) { setRunError('Write a query first.'); return; }
        body.logsQuery = { kql: logsKql, timeWindowDays: 30 };
      }

      const res = await fetch(RUN_URL[backend], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json() as RunResult | { error: string };
      if (!res.ok || 'error' in data) {
        setRunError('error' in data ? data.error : 'The query could not be run.');
        return;
      }
      setResult(data);
      fetchHistory();
    } catch {
      setRunError('The query could not be run.');
    } finally {
      setRunning(false);
    }
  }

  async function handleSaveQuery(name: string, visibility: QueryVisibility): Promise<string | null> {
    const snapshot = currentSnapshot();
    const body = {
      name,
      queryBackend: backend,
      visibility,
      scope: snapshot.scope,
      visualQuery: snapshot.visualQuery,
      rawKql: snapshot.rawKql,
      graphQuery: snapshot.graphQuery,
      logsQuery: snapshot.logsQuery,
    };
    const res = await fetch('/api/query/saved', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json() as SavedQuery | { error: string };
    if (!res.ok || 'error' in data) return 'error' in data ? data.error : 'Could not save this query.';
    setSavedQueries(prev => [data, ...prev]);
    setLoadedSavedQueryId(data.id);
    return null;
  }

  async function handleDeleteSaved(id: string) {
    const res = await fetch(`/api/query/saved/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok) {
      setSavedQueries(prev => prev.filter(q => q.id !== id));
      if (loadedSavedQueryId === id) setLoadedSavedQueryId(undefined);
    }
  }

  function saveAsRule() {
    const rule = backend === 'resource-graph'
      ? buildRuleFromQuery({
          backend, defaultCategoryId, resourceTypesText, projectColumnsText, visualQuery,
          rawKql: argKql, scope: currentSnapshot().scope,
        })
      : backend === 'microsoft-graph'
      ? buildRuleFromQuery({ backend, defaultCategoryId, graphQuery })
      : buildRuleFromQuery({ backend, defaultCategoryId, logsKql });
    sessionStorage.setItem(QUERY_PREFILL_KEY, JSON.stringify(rule));
    router.push('/rules/new');
  }

  const canRun = backend === 'resource-graph' ? !!argKql.trim()
    : backend === 'microsoft-graph' ? true
    : !!logsKql.trim();

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
      <div className="space-y-6">
        {/* Backend switcher */}
        <div className="flex gap-2">
          {BACKEND_OPTIONS.map(opt => (
            <Button
              key={opt.value}
              type="button"
              variant={backend === opt.value ? 'default' : 'outline'}
              onClick={() => switchBackend(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>

        {backend === 'resource-graph' && (
          <>
            <Card>
              <CardHeader><CardTitle>Query target</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label>Query against</Label>
                  <Select
                    aria-label="Query against"
                    value={scopeLevel}
                    onValueChange={v => updateScopeLevel(v as RuleScope['level'])}
                    options={ARG_TABLE_OPTIONS}
                  />
                </div>
                {scopeLevel === 'resource' && (
                  <div className="space-y-1.5">
                    <Label>Resource types</Label>
                    <ResourceTypeInput value={resourceTypesText} onChange={updateResourceTypes} />
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label>Scope</Label>
                  <ScopeTreePicker
                    subscriptions={scopeSubscriptions}
                    managementGroups={scopeManagementGroups}
                    onChange={updateScope}
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Filter</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <VisualQueryBuilder
                  query={visualQuery}
                  onChange={updateVisualQuery}
                  fields={fieldsForScope(scopeLevel)}
                  heading="Filter"
                />
                <div className="space-y-1.5">
                  <Label>Output columns (optional — defaults to a standard set)</Label>
                  <div className="flex gap-2">
                    <Input
                      value={projectColumnsText}
                      onChange={e => updateProjectColumns(e.target.value)}
                      placeholder="e.g. name, resourceGroup, location"
                    />
                    <FieldCombobox
                      value={columnDraft}
                      onChange={setColumnDraft}
                      options={fieldsForScope(scopeLevel)}
                      placeholder="Add field…"
                      className="w-48 shrink-0"
                      onSelect={f => {
                        updateProjectColumns(projectColumnsText ? `${projectColumnsText}, ${f}` : f);
                        setColumnDraft('');
                      }}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>KQL</CardTitle></CardHeader>
              <CardContent>
                <Textarea
                  value={argKql}
                  onChange={e => updateArgKql(e.target.value)}
                  rows={8}
                  className="font-mono text-xs"
                  spellCheck={false}
                />
              </CardContent>
            </Card>
          </>
        )}

        {backend === 'microsoft-graph' && (
          <GraphRuleEditor value={graphQuery} onChange={setGraphQuery} />
        )}

        {backend === 'log-analytics' && (
          <Card>
            <CardHeader><CardTitle>KQL</CardTitle></CardHeader>
            <CardContent>
              <Textarea
                value={logsKql}
                onChange={e => setLogsKql(e.target.value)}
                rows={10}
                className="font-mono text-xs"
                spellCheck={false}
                placeholder="e.g. SigninLogs | where ResultType != 0 | take 100"
              />
            </CardContent>
          </Card>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={runQuery} disabled={running || !canRun}>
            <Play className="size-4" />
            {running ? 'Running…' : 'Run'}
          </Button>
          <Button variant="outline" onClick={() => setSaveDialogOpen(true)} disabled={!canRun}>
            <Save className="size-4" />
            Save query
          </Button>
          <Button variant="outline" onClick={saveAsRule} disabled={!canRun}>
            <GitBranch className="size-4" />
            Save as rule
          </Button>
          {result && <QueryExportButton rows={result.rows} />}
        </div>

        {/* Results */}
        {runError && <Callout tone="error">{runError}</Callout>}
        {result && result.truncated && (
          <Callout tone="warn">
            Azure truncated this result before it finished — {result.count.toLocaleString()} rows were seen.
            Narrow the query to see everything.
          </Callout>
        )}
        {result && !result.truncated && result.capped && (
          <Callout tone="warn">
            Showing the first {result.rows.length.toLocaleString()} of {result.count.toLocaleString()} rows.
            Narrow the query to see the rest.
          </Callout>
        )}
        {result && (
          <Card>
            <CardHeader><CardTitle>Results ({result.count.toLocaleString()})</CardTitle></CardHeader>
            <CardContent className="p-0">
              <ResultTable rows={result.rows} />
            </CardContent>
          </Card>
        )}
      </div>

      {/* Side panel: saved queries + history */}
      <div className="space-y-3">
        <div className="flex gap-2">
          <Button
            type="button" size="sm" className="flex-1"
            variant={sidePanel === 'saved' ? 'default' : 'outline'}
            onClick={() => setSidePanel('saved')}
          >
            Saved
          </Button>
          <Button
            type="button" size="sm" className="flex-1"
            variant={sidePanel === 'history' ? 'default' : 'outline'}
            onClick={() => setSidePanel('history')}
          >
            History
          </Button>
        </div>

        {sidePanel === 'saved' && (
          <Card>
            <CardContent className="space-y-1 p-2">
              {savedLoading && <p className="px-2 py-4 text-center text-xs text-ink-muted">Loading…</p>}
              {savedError && <Callout tone="error">Couldn&apos;t load saved queries.</Callout>}
              {!savedLoading && !savedError && savedQueries.length === 0 && (
                <p className="px-2 py-4 text-center text-xs text-ink-muted">No saved queries yet.</p>
              )}
              {savedQueries.map(q => (
                <div key={q.id} className="group flex items-center gap-2 px-2 py-1.5 hover:bg-surface-hover">
                  <button
                    type="button"
                    onClick={() => loadSnapshot({
                      backend: q.queryBackend,
                      scope: q.scope,
                      visualQuery: q.visualQuery,
                      rawKql: q.rawKql,
                      graphQuery: q.graphQuery,
                      logsQuery: q.logsQuery,
                    })}
                    className="min-w-0 flex-1 truncate text-left text-sm text-ink"
                    title={q.name}
                  >
                    {q.name}
                    <span className="ml-1.5 text-xs text-ink-muted">{q.visibility === 'shared' ? '· shared' : ''}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteSaved(q.id)}
                    className="shrink-0 text-xs text-ink-faint opacity-0 transition-opacity hover:text-sev-critical group-hover:opacity-100"
                    title="Delete"
                  >
                    Delete
                  </button>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {sidePanel === 'history' && (
          <Card>
            <CardContent className="space-y-1 p-2">
              {historyLoading && <p className="px-2 py-4 text-center text-xs text-ink-muted">Loading…</p>}
              {historyError && <Callout tone="error">Couldn&apos;t load run history.</Callout>}
              {!historyLoading && !historyError && history.length === 0 && (
                <p className="px-2 py-4 text-center text-xs text-ink-muted">No runs yet.</p>
              )}
              {history.map(h => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => loadSnapshot({
                    backend: h.queryBackend,
                    scope: h.scope,
                    rawKql: h.rawKql,
                    graphQuery: h.graphQuery,
                    logsQuery: h.logsQuery,
                  })}
                  className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left hover:bg-surface-hover"
                >
                  <span className="min-w-0 truncate text-sm text-ink">
                    {BACKEND_OPTIONS.find(o => o.value === h.queryBackend)?.label}
                  </span>
                  <span className="shrink-0 text-xs text-ink-muted">
                    {h.count.toLocaleString()} rows · {formatWhen(h.ranAt)}
                  </span>
                </button>
              ))}
            </CardContent>
          </Card>
        )}
      </div>

      {saveDialogOpen && <SaveQueryDialog onClose={() => setSaveDialogOpen(false)} onSave={handleSaveQuery} />}
    </div>
  );
}
