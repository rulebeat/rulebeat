'use client';

import { useEffect, useLayoutEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { fetchJson } from '@/lib/fetch-json';
import type { PreflightResult } from '@/lib/preflight';
import type { SystemDiagnostics } from '@/lib/diagnostics';
import { PreflightChecks, STATUS_ICON } from '@/components/diagnostics/preflight-checks';
import { Callout } from '@/components/ui/callout';
import { Activity, Loader2, Play, RefreshCw, ShieldCheck } from 'lucide-react';

const STALL_THRESHOLD_S = 75;
const PREFLIGHT_STORAGE_KEY = 'rulebeat.diagnostics.preflight';

function loadStoredPreflight(): PreflightResult | null {
  try {
    const raw = localStorage.getItem(PREFLIGHT_STORAGE_KEY);
    return raw ? JSON.parse(raw) as PreflightResult : null;
  } catch {
    return null;
  }
}

function storePreflightResult(result: PreflightResult): void {
  try {
    localStorage.setItem(PREFLIGHT_STORAGE_KEY, JSON.stringify(result));
  } catch {
    // localStorage unavailable in some hardened environments; results still show for the session
  }
}

function fmtAge(isoDate: string | null): string {
  if (!isoDate) return 'never';
  const secs = Math.round((Date.now() - new Date(isoDate).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function fmtDateTime(isoDate: string): string {
  const d = new Date(isoDate);
  return d.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' })
    + ' at '
    + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* The same three outcomes the preflight list draws, so it borrows that icon map
   rather than keeping a second one here. Two copies had already drifted once. */
function StatusDot({ status }: { status: 'ok' | 'warn' | 'fail' }) {
  return <>{STATUS_ICON[status]}</>;
}

function CheckedAt({ isoDate }: { isoDate: string }) {
  return (
    <span className="text-xs text-ink-muted">
      Last checked at {fmtDateTime(isoDate)}
    </span>
  );
}

function SystemSection({ data }: { data: SystemDiagnostics }) {
  const { storage, scheduler, schemaCache } = data;

  // Which database this process is on. A deployment can run on the wrong backend with no symptom
  // until a restart empties it, so this row exists to be read before that happens. SQLite chosen
  // by nothing at all gets the one sentence that names the risk.
  const storageSummary = storage.kind === 'postgres'
    ? `PostgreSQL at ${storage.host ?? 'unknown host'}${storage.port ? `:${storage.port}` : ''}${storage.database ? `/${storage.database}` : ''}${storage.user ? ` as ${storage.user}` : ''}.`
    : `SQLite file at ${storage.file ?? 'the data directory'}.`;

  const storageSelection = storage.selectedBy === 'default'
    ? 'Nothing selected it: RULEBEAT_DATABASE_URL is unset. On a host with no persistent volume this database is lost on restart; set RULEBEAT_DATABASE_BACKEND=postgres to require Postgres.'
    : `Selected by ${storage.selectedBy}.`;

  const schedulerStatus: 'ok' | 'warn' | 'fail' =
    !scheduler.enabled ? 'warn'
    : !scheduler.started ? 'fail'
    : (scheduler.secondsSinceTick !== null && scheduler.secondsSinceTick > STALL_THRESHOLD_S) ? 'warn'
    : 'ok';

  const schedulerSummary = !scheduler.enabled
    ? 'Disabled at the server level. Scan schedules will not run automatically.'
    : !scheduler.started
      ? 'Did not start.'
      : scheduler.lastTickAt === null
        ? 'Running. No activity recorded yet since the server started.'
        : schedulerStatus === 'warn'
          ? `May have stopped. Last activity ${fmtAge(scheduler.lastTickAt)}.`
          : `Running normally. Last activity ${fmtAge(scheduler.lastTickAt)}.`;

  const schedulerRemediation = !scheduler.enabled
    ? 'Disabled at the server level via RULEBEAT_DISABLE_SCHEDULER. To re-enable, remove that variable from your server environment and restart.'
    : !scheduler.started
      ? 'Check the server startup logs for errors, then restart the server.'
      : schedulerStatus === 'warn'
        ? 'The server may be under load. If this persists after refreshing, restart the server.'
        : null;

  const cacheStatus: 'ok' | 'warn' | 'fail' =
    schemaCache.schemaEntryCount === 0 ? 'warn'
    : schemaCache.typeListStale ? 'warn'
    : 'ok';

  const cacheSummary = schemaCache.schemaEntryCount === 0
    ? 'Not loaded yet.'
    : schemaCache.typeListStale
      ? `Resource type list is outdated (last refreshed ${fmtAge(schemaCache.typeListCachedAt)}). Holding ${schemaCache.typeCount} types.`
      : `Up to date. ${schemaCache.typeCount} resource types cached.`;

  const cacheRemediation = schemaCache.schemaEntryCount === 0
    ? 'Schemas load automatically on first use. To warm the cache immediately, restart the server.'
    : schemaCache.typeListStale
      ? 'A background refresh runs daily. To force an immediate refresh, restart the server.'
      : null;

  const cacheDetail = schemaCache.schemaEntryCount > 0
    ? `${schemaCache.schemaEntryCount} resource ${schemaCache.schemaEntryCount === 1 ? 'type' : 'types'} with full property schemas cached`
    : null;

  return (
    <ul className="divide-y divide-border bg-surface">
      <li className="flex items-start gap-3 px-3.5 py-3">
        <StatusDot status="ok" />
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium text-ink">Storage</p>
          <p className="text-xs leading-relaxed text-ink-2">
            Where rules, findings, settings and history are kept.
          </p>
          <p className="break-all text-xs leading-relaxed text-ink-2">{storageSummary}</p>
          <p className="text-xs leading-relaxed text-ink-2">{storageSelection}</p>
        </div>
      </li>
      <li className="flex items-start gap-3 px-3.5 py-3">
        <StatusDot status={schedulerStatus} />
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium text-ink">Scheduled scans</p>
          <p className="text-xs leading-relaxed text-ink-2">
            Runs your configured scan schedules automatically in the background.
          </p>
          <p className="text-xs leading-relaxed text-ink-2">{schedulerSummary}</p>
          {schedulerRemediation && (
            <p className="text-xs leading-relaxed text-ink-2">{schedulerRemediation}</p>
          )}
        </div>
      </li>
      <li className="flex items-start gap-3 px-3.5 py-3">
        <StatusDot status={cacheStatus} />
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium text-ink">Azure resource schemas</p>
          <p className="text-xs leading-relaxed text-ink-2">
            A local copy of Azure resource type definitions. Powers the field autocomplete
            when you build rules.
          </p>
          <p className="text-xs leading-relaxed text-ink-2">{cacheSummary}</p>
          {cacheRemediation && (
            <p className="text-xs leading-relaxed text-ink-2">{cacheRemediation}</p>
          )}
          {cacheDetail && (
            <p className="text-xs leading-relaxed text-ink-faint">{cacheDetail}</p>
          )}
        </div>
      </li>
    </ul>
  );
}

export function DiagnosticsClient() {
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  // true once the localStorage read has happened — prevents "not yet checked" from flashing
  // before we know whether stored results exist.
  const [preflightReady, setPreflightReady] = useState(false);
  const [system, setSystem] = useState<SystemDiagnostics | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [systemLoading, setSystemLoading] = useState(true);
  const [preflightError, setPreflightError] = useState(false);

  // localStorage is unavailable during SSR. useLayoutEffect fires synchronously during hydration,
  // before the first browser paint — so stored results appear without a visible empty-state flash.
  // localStorage restore before first paint is the whole point of useLayoutEffect here, not
  // derivable render state (see comment above).
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreflight(loadStoredPreflight());
    setPreflightReady(true);
  }, []);

  useEffect(() => {
    // System checks are instant local reads — load once on mount, never on every refresh.
    void fetchJson<SystemDiagnostics>('/api/diagnostics/system').then(result => {
      setSystem(result.ok ? result.data : null);
      setSystemLoading(false);
    });
  }, []);

  async function runAzureChecks() {
    setPreflightLoading(true);
    setPreflightError(false);
    const result = await fetchJson<PreflightResult>('/api/diagnostics/preflight');
    if (result.ok) storePreflightResult(result.data);
    setPreflight(result.ok ? result.data : null);
    setPreflightError(!result.ok);
    setPreflightLoading(false);
  }

  async function refreshSystem() {
    setSystemLoading(true);
    const result = await fetchJson<SystemDiagnostics>('/api/diagnostics/system');
    setSystem(result.ok ? result.data : null);
    setSystemLoading(false);
  }

  return (
    <div className="max-w-2xl space-y-6">
      {/* Azure connectivity */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 pb-3">
          <div className="min-w-0 space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="size-4 text-ink-muted" />
              Azure connectivity
            </CardTitle>
            {preflight && <CheckedAt isoDate={preflight.ranAt} />}
          </div>
          <Button
            size="sm"
            variant={preflight ? 'outline' : 'default'}
            onClick={() => void runAzureChecks()}
            disabled={preflightLoading}
          >
            {preflightLoading
              ? <Loader2 className="size-3.5 animate-spin" />
              : preflight
                ? <RefreshCw className="size-3.5" />
                : <Play className="size-3.5" />}
            {preflight ? 'Re-run' : 'Run checks'}
          </Button>
        </CardHeader>
        <CardContent>
          {preflightReady && !preflight && !preflightLoading && !preflightError && (
            <p className="py-2 text-sm text-ink-2">
              Verifies that RuleBeat can authenticate to Azure and reach Resource Graph and
              Microsoft Graph. Run manually when you change credentials or troubleshoot a scan issue.
            </p>
          )}
          {preflightLoading && (
            <div className="flex items-center gap-2 py-2 text-sm text-ink-muted">
              <Loader2 className="size-4 animate-spin" />
              Running checks…
            </div>
          )}
          {preflightError && !preflightLoading && (
            <Callout tone="error">Could not run Azure checks. Check the server logs.</Callout>
          )}
          {preflight && <PreflightChecks result={preflight} />}
        </CardContent>
      </Card>

      {/* System */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 pb-3">
          <div className="min-w-0 space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="size-4 text-ink-muted" />
              System
              {system && <span className="label-grid text-ink-faint">v{system.version}</span>}
            </CardTitle>
            {system && <CheckedAt isoDate={system.checkedAt} />}
          </div>
          <Button size="sm" variant="outline" onClick={() => void refreshSystem()} disabled={systemLoading}>
            {systemLoading
              ? <Loader2 className="size-3.5 animate-spin" />
              : <RefreshCw className="size-3.5" />}
            Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {systemLoading && !system && (
            <div className="flex items-center gap-2 py-2 text-sm text-ink-muted">
              <Loader2 className="size-4 animate-spin" />
              Loading…
            </div>
          )}
          {!systemLoading && !system && (
            <Callout tone="error">Could not load system status.</Callout>
          )}
          {system && <SystemSection data={system} />}
        </CardContent>
      </Card>
    </div>
  );
}
