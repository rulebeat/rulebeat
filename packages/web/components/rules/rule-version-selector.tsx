'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { PACK_LABELS } from '@/lib/pack-labels';
import { changedFields } from '@/lib/changed-fields';
import { diffQueryLines, versionLabel } from '@/lib/rule-version-preview';
import { formatVersionDate, isCommitDateVersion } from '@/lib/rule-version-markers';
import type { Rule, RuleVersionDefinition, RuleVersionHistory } from '@/lib/types';

const FIELD_LABELS: Record<keyof RuleVersionDefinition, string> = {
  name: 'Name', description: 'Description and recommendation', category: 'Category', severity: 'Severity',
  queryBackend: 'Query backend', kind: 'Kind', resourceTypes: 'Resource types', scope: 'Scope',
  conditions: 'Conditions', conditionGroups: 'Condition groups', visualQuery: 'Visual query',
  projectColumns: 'Output columns', rawKql: 'Raw KQL', graphQuery: 'Microsoft Graph query', logsQuery: 'Logs query',
};

function displayValue(value: unknown): string {
  if (value === null) return 'Not set';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

export function RuleVersionSelector({
  rule, history, canSwitch, blocked = false,
}: {
  rule: Rule;
  history: RuleVersionHistory;
  canSwitch: boolean;
  blocked?: boolean;
}) {
  const router = useRouter();
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = history.versions.find(v => v.isRunning);
  const selected = history.versions.find(v => v.version === selectedVersion) ?? running;
  const reviewing = selected !== undefined && !selected.isRunning;
  const changed = selected ? changedFields(history.currentDefinition, selected.definition) : [];
  const queryDiff = reviewing && selected ? diffQueryLines(history.currentQuery, selected.query) : [];

  function selectorVersionLabel(version: string | undefined): string {
    const sameDay = version !== undefined && isCommitDateVersion(version)
      && history.versions.filter(v => isCommitDateVersion(v.version)
        && formatVersionDate(v.version) === formatVersionDate(version)).length > 1;
    return versionLabel(version, sameDay);
  }

  async function save() {
    if (!canSwitch || !selected || selected.isRunning || blocked || saving) return;
    setError(null);
    setSaving(true);
    try {
      const response = await fetch(`/api/rules/${encodeURIComponent(rule.id)}/version`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: selected.version }),
      });
      if (!response.ok) {
        const body: { error?: string } = await response.json();
        setError(body.error ?? 'Could not switch the Rule version.');
        return;
      }
      setSelectedVersion(null);
      router.refresh();
    } catch {
      setError('Could not switch the Rule version. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rule version</CardTitle>
        <span className="text-xs text-ink-2">
          Running {selectorVersionLabel(rule.version)}
        </span>
      </CardHeader>
      <CardContent className="space-y-4">
        {history.retired && (
          <p className="text-sm text-ink-2">Retired. {PACK_LABELS[rule.pack ?? 'rulebeat-core'] ?? rule.pack} no longer ships this rule.</p>
        )}
        {history.versions.length === 0 ? (
          <p className="text-sm text-ink-2">No Rule versions have been recorded for this rule on this install.</p>
        ) : (
          <>
            <div className="max-w-lg space-y-2">
              <Select
                aria-label="Rule version"
                value={selected?.version ?? null}
                disabled={saving}
                onValueChange={value => { setSelectedVersion(value); setError(null); }}
                options={history.versions.map(v => ({
                  value: v.version,
                  label: `${selectorVersionLabel(v.version)}${v.isRunning ? ' (running)' : ''}${v.isNewer ? ' · New' : ''}`,
                }))}
              />
              <p className="text-xs text-ink-2">
                {canSwitch ? 'Review the changes before switching. Nothing runs until the next scan.' : 'Version history is read-only. Only an admin can switch Rule versions.'}
              </p>
            </div>
            {selected && (
              <div className="space-y-1 text-sm text-ink-2">
                <p><span className="font-medium">Date:</span> <time dateTime={selected.date}>{formatVersionDate(selected.date)}</time></p>
                <p>{selected.releaseNote}</p>
                {selected.upstreamRef && <p className="break-all font-mono text-xs">Upstream reference: {selected.upstreamRef}</p>}
              </div>
            )}
            <details className="text-sm text-ink-2">
              <summary className="cursor-pointer font-medium">Version history</summary>
              <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {history.versions.map(v => (
                  <li key={v.version} className="space-y-1 bg-surface-sunken p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" className="font-medium text-ink underline underline-offset-4" disabled={saving}
                        onClick={() => { setSelectedVersion(v.version); setError(null); }}>
                        {selectorVersionLabel(v.version)}
                      </button>
                      {v.isRunning && <span className="text-xs">Running</span>}
                      {v.isNewer && <span className="bg-surface px-1.5 py-0.5 text-xs font-medium">New</span>}
                    </div>
                    <time dateTime={v.date} className="text-xs">{formatVersionDate(v.date)}</time>
                    <p>{v.releaseNote}</p>
                    {v.upstreamRef && <p className="break-all font-mono text-xs">Upstream reference: {v.upstreamRef}</p>}
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
        {reviewing && selected && (
          <section aria-label="Version changes" className="space-y-4 border-t border-rule-faint pt-4">
            <h3 className="title-grid">
              {selectorVersionLabel(rule.version)} to {selectorVersionLabel(selected.version)}
            </h3>
            {changed.length === 0 && <p className="text-sm text-ink-2">The definition is unchanged in this version.</p>}
            {changed.map(field => (
              <div key={field} className="space-y-2">
                <h4 className="text-sm font-medium">{FIELD_LABELS[field]}</h4>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="bg-surface-sunken p-3">
                    <p className="label-grid mb-2">Before</p>
                    <pre className="whitespace-pre-wrap break-all text-xs text-ink-2">{displayValue(history.currentDefinition[field])}</pre>
                  </div>
                  <div className="bg-surface-sunken p-3">
                    <p className="label-grid mb-2">After</p>
                    <pre className="whitespace-pre-wrap break-all text-xs text-ink-2">{displayValue(selected.definition[field])}</pre>
                  </div>
                </div>
              </div>
            ))}
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Query line diff</h4>
              <p className="text-xs text-ink-2">- Removed from the running query. + Added in the selected version.</p>
              <pre aria-label="Query line diff" className="bg-surface-sunken p-3 whitespace-pre-wrap break-all text-xs">
                {queryDiff.map((line, index) => (
                  <span key={index} className={`block ${line.kind === 'removed' ? 'text-muted-foreground line-through' : line.kind === 'added' ? 'text-ink font-medium' : 'text-ink-2'}`}>
                    {line.kind === 'removed' ? '- ' : line.kind === 'added' ? '+ ' : '  '}{line.text || '\u00a0'}
                  </span>
                ))}
              </pre>
            </div>
            {blocked && canSwitch && <p className="text-sm text-ink-2">Save or discard your pending rule changes before switching versions.</p>}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-2">
              {canSwitch && (
                <Button onClick={() => { void save(); }} disabled={saving || blocked}>
                  {saving ? 'Switching...' : 'Switch version'}
                </Button>
              )}
              <Button variant="outline" disabled={saving} onClick={() => { setSelectedVersion(null); setError(null); }}>
                Close review
              </Button>
            </div>
          </section>
        )}
      </CardContent>
    </Card>
  );
}
