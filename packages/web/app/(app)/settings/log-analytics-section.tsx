'use client';

import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { FieldHint, Input, Label } from '@/components/ui/input';
import type { LogAnalyticsWorkspaceStatus } from '@/lib/log-analytics-workspace';
import { Check, Database, Loader2, Lock, Plug, Trash2 } from 'lucide-react';

/**
 * Settings → Log Analytics workspace (spec 035).
 *
 * The default workspace `queryBackend: 'log-analytics'` rules query. Deliberately simpler than the
 * Azure connection card above it: there is no secret here, because a workspace query is authorized by
 * the Azure credential already configured there, not a separate identity.
 */

function StatusBadge({ status }: { status: LogAnalyticsWorkspaceStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 bg-surface-sunken px-2 py-0.5 text-xs font-medium text-ink-2">
      <Check className="size-3 shrink-0 text-status-ok" />
      {status.sourceLabel ?? 'Connected'}
    </span>
  );
}

function StatusDetail({ status }: { status: LogAnalyticsWorkspaceStatus }) {
  if (!status.workspaceId) return null;
  return (
    <p className="text-xs text-ink-muted">
      <span className="break-all font-mono">Workspace {status.workspaceId}</span>
      {status.stored?.lastVerifiedAt && (
        <span> · Last verified {new Date(status.stored.lastVerifiedAt).toLocaleString()}</span>
      )}
    </p>
  );
}

export function LogAnalyticsSection({ initialStatus }: { initialStatus: LogAnalyticsWorkspaceStatus }) {
  const [status, setStatus] = useState(initialStatus);
  const [workspaceId, setWorkspaceId] = useState(initialStatus.stored?.workspaceId ?? '');
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const locked = status.managedByEnv;

  function reset(next: LogAnalyticsWorkspaceStatus) {
    setStatus(next);
    setWorkspaceId(next.stored?.workspaceId ?? '');
  }

  async function handleSave() {
    setBusy('save'); setError(null); setSuccess(null);
    try {
      const res = await fetch('/api/settings/log-analytics-workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: workspaceId.trim() }),
      });
      const body = await res.json() as LogAnalyticsWorkspaceStatus & { error?: string };
      if (!res.ok) { setError(body.error ?? 'Could not save the workspace.'); return; }
      reset(body);
      setSuccess('Saved. RuleBeat verified this workspace against Azure before storing it.');
    } catch {
      setError('Could not reach the RuleBeat server.');
    } finally { setBusy(null); }
  }

  async function handleRemove() {
    if (!confirm('Remove the stored Log Analytics workspace? Rules that query Log Analytics will report "not configured" until another workspace is set.')) return;
    setBusy('remove'); setError(null); setSuccess(null);
    try {
      const res = await fetch('/api/settings/log-analytics-workspace', { method: 'DELETE' });
      const body = await res.json() as LogAnalyticsWorkspaceStatus & { error?: string };
      if (!res.ok) { setError(body.error ?? 'Could not remove the workspace.'); return; }
      reset(body);
    } catch {
      setError('Could not reach the RuleBeat server.');
    } finally { setBusy(null); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="size-4 text-ink-muted" />
          Log Analytics workspace
          {status.configured && <StatusBadge status={status} />}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        {status.configured ? (
          <StatusDetail status={status} />
        ) : (
          <Callout tone="info" title="No workspace configured">
            {status.message}
          </Callout>
        )}

        {error && <Callout tone="error">{error}</Callout>}
        {success && <Callout tone="success">{success}</Callout>}

        {locked ? (
          <div className="space-y-3 text-xs leading-relaxed text-ink-2">
            <div className="flex items-start gap-2">
              <Lock className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Environment variables always win over anything entered here. Edit{' '}
                <code className="font-mono text-ink">RULEBEAT_LOG_ANALYTICS_WORKSPACE_ID</code> where
                this deployment defines it, then restart, to change the workspace.
              </span>
            </div>
          </div>
        ) : (
          <>
            <p className="text-xs leading-relaxed text-ink-2">
              The workspace ID is on the workspace&apos;s Overview page in the Azure portal. The Azure
              credential configured above needs the <strong className="font-medium text-ink">Log
              Analytics Reader</strong> role on it.
            </p>

            <div className="space-y-1.5">
              <Label htmlFor="law-workspace-id">Workspace ID</Label>
              <Input
                id="law-workspace-id"
                value={workspaceId}
                onChange={e => setWorkspaceId(e.target.value)}
                placeholder="00000000-0000-0000-0000-000000000000"
                className="font-mono"
              />
              <FieldHint>Used as the single default workspace for every Log Analytics rule.</FieldHint>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <Button size="sm" onClick={handleSave} disabled={busy !== null || !workspaceId.trim()}>
                {busy === 'save' ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
                {status.stored ? 'Update workspace' : 'Connect workspace'}
              </Button>
              {status.stored && (
                <Button size="sm" variant="destructive" onClick={handleRemove} disabled={busy !== null}>
                  <Trash2 className="size-3.5" />
                  Remove
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
