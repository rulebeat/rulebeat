'use client';

import { Fragment, useState } from 'react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableScroll,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CodeBlock } from '@/components/ui/code-block';
import { ChecklistDropdown } from '@/components/ui/checklist-dropdown';
import { Input } from '@/components/ui/input';
import { SeverityBadge, SeverityChip } from './severity-badge';
import { ExportButton } from './export-button';
import type { Finding, Suppression, Severity } from '@/lib/types';
import { ExternalLink, ChevronDown, ChevronRight, Copy, Check, EyeOff, Eye, Terminal, X, Sparkles } from 'lucide-react';
import type { RemediationStepType } from '@/lib/types';
import { splitLearnMore } from '@/lib/rule-description';
import { cn } from '@/lib/utils';
import { useResizableColumns, ColumnResizeHandle } from '@/lib/hooks/use-resizable-columns';

const STEP_LABELS: Record<string, string> = {
  'az-cli': 'Az CLI',
  powershell: 'PowerShell',
  portal: 'Portal',
  terraform: 'Terraform',
  bicep: 'Bicep',
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="shrink-0 p-1 transition-colors hover:bg-surface-hover"
    >
      {copied ? <Check className="size-3 text-status-ok" /> : <Copy className="size-3 text-ink-muted" />}
    </button>
  );
}

function FindingRow({
  finding,
  suppression,
  onSuppress,
  onUnsuppress,
}: {
  finding: Finding;
  suppression?: Suppression;
  onSuppress?: (finding: Finding, reason: string, expiresAt?: string) => void;
  onUnsuppress?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [suppressReason, setSuppressReason] = useState('');
  const [suppressExpiry, setSuppressExpiry] = useState('');

  const isSuppressed = !!suppression;
  const evidence = finding.evidence;
  const presentTags = evidence.presentTags as Record<string, string> | undefined;

  function handleSuppress() {
    if (!suppressReason.trim() || !onSuppress) return;
    onSuppress(finding, suppressReason.trim(), suppressExpiry || undefined);
    setSuppressReason('');
    setSuppressExpiry('');
  }

  return (
    <>
      <TableRow
        interactive={!isSuppressed}
        className={cn('cursor-pointer', isSuppressed && 'opacity-50')}
        onClick={() => setExpanded(!expanded)}
      >
        <TableCell className="w-8">
          {expanded
            ? <ChevronDown className="size-3.5 text-ink-muted" />
            : <ChevronRight className="size-3.5 text-ink-muted" />}
        </TableCell>
        <TableCell><SeverityBadge severity={finding.severity} /></TableCell>
        <TableCell className="max-w-xs truncate text-sm font-medium text-ink">
          {finding.title}
          {isSuppressed && (
            <Badge variant="ghost" className="ml-2">suppressed</Badge>
          )}
        </TableCell>
        <TableCell className="max-w-xs truncate text-[13px] text-ink">
          {finding.resourceName || finding.dimensionKey || finding.resourceId?.split('/').pop()}
        </TableCell>
        <TableCell className="text-[13px] text-ink">{finding.resourceGroup}</TableCell>
        <TableCell>
          <Badge variant="outline" className="font-mono">
            {finding.ruleId}
          </Badge>
        </TableCell>
        <TableCell className="text-right">
          {finding.azurePortalLink && (
            <a
              href={finding.azurePortalLink}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-[13px] font-medium text-ink underline-offset-4 hover:underline"
            >
              Portal <ExternalLink className="size-3" />
            </a>
          )}
        </TableCell>
      </TableRow>

      {expanded && (
        <TableRow className="bg-surface-sunken">
          <TableCell colSpan={7} className="px-6 py-4">
            <div className="space-y-4">

              {/* Resource context */}
              <div>
                <p className="label-grid mb-2.5">{finding.kind === 'activity' ? 'Activity pattern' : 'Resource'}</p>
                {finding.kind === 'activity' ? (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-8 gap-y-1.5 text-[13px]">
                    <dt className="shrink-0 text-ink-2">Pattern</dt>
                    <dd className="font-mono text-xs text-ink">{finding.dimensionKey}</dd>
                    <dt className="shrink-0 text-ink-2">Subscription</dt>
                    <dd className="flex items-center gap-1 font-mono text-xs text-ink">{finding.subscriptionId} <CopyButton text={finding.subscriptionId} /></dd>
                  </dl>
                ) : (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-8 gap-y-1.5 text-[13px]">
                    <dt className="shrink-0 text-ink-2">Type</dt>
                    <dd className="font-mono text-xs text-ink">{finding.resourceType}</dd>
                    {finding.location && (
                      <>
                        <dt className="shrink-0 text-ink-2">Location</dt>
                        <dd className="text-ink">{finding.location}</dd>
                      </>
                    )}
                    {finding.resourceGroup && (
                      <>
                        <dt className="shrink-0 text-ink-2">Resource Group</dt>
                        <dd className="flex items-center gap-1 text-ink">{finding.resourceGroup} <CopyButton text={finding.resourceGroup} /></dd>
                      </>
                    )}
                    <dt className="shrink-0 text-ink-2">Subscription</dt>
                    <dd className="flex items-center gap-1 font-mono text-xs text-ink">{finding.subscriptionId} <CopyButton text={finding.subscriptionId} /></dd>
                    {finding.resourceId && (
                      <>
                        <dt className="shrink-0 text-ink-2">Resource ID</dt>
                        <dd className="flex items-center gap-1 break-all font-mono text-xs text-ink">{finding.resourceId} <CopyButton text={finding.resourceId} /></dd>
                      </>
                    )}
                  </dl>
                )}
                {presentTags && Object.keys(presentTags).length > 0 && (
                  <div className="mt-3">
                    <p className="label-grid mb-1.5">Current tags</p>
                    <div className="flex flex-wrap gap-1.5">
                      {Object.entries(presentTags).map(([k, v]) => (
                        <Badge key={k} variant="outline" className="font-mono">
                          {k}: {v}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Resource data — projected columns from the policy query */}
              {(() => {
                // Support both old evidence format {field,operator,value} and new {_rule,...data}
                const isNew = '_rule' in evidence;
                const ruleInfo = isNew
                  ? (evidence._rule as Record<string, unknown> | undefined)
                  : { field: evidence['field'], operator: evidence['operator'], value: evidence['value'], values: evidence['values'] };
                const dataEntries = Object.entries(evidence).filter(([k]) =>
                  isNew ? k !== '_rule' : !['field', 'operator', 'value', 'values', 'presentTags'].includes(k)
                );
                return (
                  <>
                    {dataEntries.length > 0 && (
                      <div>
                        <p className="label-grid mb-2.5">Resource Data</p>
                        <dl className="grid grid-cols-[auto_1fr] gap-x-8 gap-y-1.5">
                          {dataEntries.map(([k, v]) => (
                            <Fragment key={k}>
                              <dt className="shrink-0 pt-0.5 font-mono text-xs text-ink-2">{k}</dt>
                              <dd className="break-all font-mono text-xs text-ink">
                                {typeof v === 'object' && v !== null
                                  ? <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(v, null, 2)}</pre>
                                  : String(v ?? '')}
                              </dd>
                            </Fragment>
                          ))}
                        </dl>
                      </div>
                    )}
                    {ruleInfo && (ruleInfo['field'] || ruleInfo['operator']) && (
                      <div>
                        <p className="label-grid mb-1.5">Violated rule</p>
                        <p className="font-mono text-xs text-ink">
                          {String(ruleInfo['field'] ?? '')}
                          {' '}
                          <span className="text-ink">{String(ruleInfo['operator'] ?? '')}</span>
                          {ruleInfo['value'] != null && <> <span className="font-medium text-ink">&apos;{String(ruleInfo['value'])}&apos;</span></>}
                          {Array.isArray(ruleInfo['values']) && <> [{(ruleInfo['values'] as string[]).map(v => `'${v}'`).join(', ')}]</>}
                        </p>
                      </div>
                    )}
                  </>
                );
              })()}

              {/* Recommendation — the trailing "Learn more" URL is split out and linked, never shown as raw text */}
              {(() => {
                const { text, url } = splitLearnMore(finding.recommendation);
                return (
                  <div>
                    <p className="label-grid mb-1.5">Recommendation</p>
                    <p className="text-[13px] text-ink-2">{text}</p>
                    {url && (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="mt-2 inline-flex items-center gap-1.5 text-[13px] font-medium text-ink underline-offset-4 hover:underline"
                      >
                        Read the official guidance
                        <ExternalLink className="size-3.5" />
                      </a>
                    )}
                  </div>
                );
              })()}

              {/* Remediation — generated per rule, not authored per rule. Until that
                  generation ships, show why the fix block is empty rather than hiding it. */}
              {finding.remediationSteps.length === 0 && (
                <div>
                  <p className="label-grid mb-2.5">Remediation</p>
                  <div className="flex items-start gap-2.5 border border-dashed border-border bg-surface px-3.5 py-3">
                    <Sparkles className="mt-px size-4 shrink-0 text-ink-muted" />
                    <div>
                      <p className="text-[13px] font-medium text-ink">Guided fix coming soon</p>
                      <p className="mt-0.5 text-xs text-ink-muted">
                        RuleBeat will generate remediation for this finding from the rule that detected it, so it fits your resource rather than a generic template.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Remediation steps */}
              {finding.remediationSteps.length > 0 && (
                <div>
                  <p className="label-grid mb-2.5">Remediation Steps</p>
                  <div className="space-y-2.5">
                    {finding.remediationSteps.map((step, i) => {
                      const content = step.content.replace(/["']?<resource-id>["']?/g, `"${finding.resourceId}"`);
                      return (
                        <CodeBlock
                          key={i}
                          title={STEP_LABELS[step.type] ?? step.type}
                          code={content}
                        />
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Suppression */}
              {(onSuppress ?? onUnsuppress) && (
                <div className="border-t border-border pt-3">
                  {isSuppressed && suppression ? (
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="label-grid mb-1">Suppressed</p>
                        <p className="text-[13px] text-ink">{suppression.reason}</p>
                        {suppression.expiresAt && (
                          <p className="mt-0.5 text-xs text-ink-muted">
                            Expires {new Date(suppression.expiresAt).toLocaleDateString()}
                          </p>
                        )}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        onClick={(e) => { e.stopPropagation(); onUnsuppress?.(suppression.id); }}
                      >
                        Remove suppression
                      </Button>
                    </div>
                  ) : (
                    <div>
                      <p className="label-grid mb-2.5">Suppress this finding</p>
                      <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                        <Input
                          inputSize="sm"
                          value={suppressReason}
                          onChange={e => setSuppressReason(e.target.value)}
                          placeholder="Reason (e.g. accepted risk, false positive)"
                          className="flex-1"
                        />
                        <Input
                          inputSize="sm"
                          type="date"
                          value={suppressExpiry}
                          onChange={e => setSuppressExpiry(e.target.value)}
                          title="Expiry date (optional)"
                          className="w-auto"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          className="shrink-0"
                          disabled={!suppressReason.trim()}
                          onClick={handleSuppress}
                        >
                          Suppress
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}

            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function generateBulkScript(findings: Finding[], type: RemediationStepType): string {
  const lines = [
    `# Bulk remediation script, generated by RuleBeat`,
    `# ${new Date().toUTCString()} · ${findings.length} finding${findings.length !== 1 ? 's' : ''}`,
    '',
  ];
  for (const f of findings) {
    const step = f.remediationSteps.find(s => s.type === type);
    if (!step) continue;
    lines.push(`# ${f.title}: ${f.resourceName}`);
    lines.push(step.content.replace(/["']?<resource-id>["']?/g, `"${f.resourceId}"`));
    lines.push('');
  }
  return lines.join('\n').trim();
}

function BulkScriptPanel({ findings }: { findings: Finding[] }) {
  const [tab, setTab] = useState<RemediationStepType>('az-cli');

  const hasAzCli = findings.some(f => f.remediationSteps.some(s => s.type === 'az-cli'));
  const hasPs = findings.some(f => f.remediationSteps.some(s => s.type === 'powershell'));

  const activeTab: RemediationStepType = hasAzCli ? tab : 'powershell';
  const script = generateBulkScript(findings, activeTab);

  return (
    <div className="border-t border-border p-4">
      <CodeBlock
        code={script || '# No remediation commands available for visible findings'}
        title="Bulk script"
        actions={
          <div className="flex items-center gap-1">
            {hasAzCli && (
              <ScriptTab label="Az CLI" active={activeTab === 'az-cli'} onClick={() => setTab('az-cli')} />
            )}
            {hasPs && (
              <ScriptTab label="PowerShell" active={activeTab === 'powershell'} onClick={() => setTab('powershell')} />
            )}
          </div>
        }
      />
    </div>
  );
}

function ScriptTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'border px-2 py-0.5 text-xs transition-colors',
        active
          ? 'border-ink bg-ink text-surface'
          : 'border-transparent text-ink-2 hover:text-ink',
      )}
    >
      {label}
    </button>
  );
}

interface FindingsTableProps {
  findings: Finding[];
  suppressions?: Suppression[];
  onSuppress?: (finding: Finding, reason: string, expiresAt?: string) => void;
  onUnsuppress?: (id: string) => void;
}

const SEV_ALL: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export function FindingsTable({ findings, suppressions = [], onSuppress, onUnsuppress }: FindingsTableProps) {
  const { widths: colWidths, startResize, isFlexible } = useResizableColumns<'severity' | 'finding' | 'resource' | 'resourceGroup' | 'rule'>(
    { severity: 110, finding: 260, resource: 220, resourceGroup: 160, rule: 160 },
    { flexCol: 'finding' },
  );
  const [showSuppressed, setShowSuppressed] = useState(false);
  const [showBulkScript, setShowBulkScript] = useState(false);
  const [selectedSeverities, setSelectedSeverities] = useState<Set<Severity>>(new Set());
  const [selectedPolicies, setSelectedPolicies] = useState<Set<string>>(new Set());

  // Unique policies from findings (ruleId → label)
  const policyOptions = (() => {
    const map = new Map<string, { label: string; count: number }>();
    for (const f of findings) {
      const existing = map.get(f.ruleId);
      if (existing) existing.count++;
      else map.set(f.ruleId, { label: f.title, count: 1 });
    }
    return Array.from(map.entries())
      .map(([value, { label, count }]) => ({ value, label, count }))
      .sort((a, b) => b.count - a.count);
  })();

  function toggleSeverity(s: Severity) {
    setSelectedSeverities(prev => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  }

  function togglePolicy(id: string) {
    setSelectedPolicies(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function clearFilters() {
    setSelectedSeverities(new Set());
    setSelectedPolicies(new Set());
  }

  const suppressedIds = new Set(
    suppressions
      .filter(s => !s.expiresAt || new Date(s.expiresAt) > new Date())
      .map(s => s.fingerprint)
  );

  const suppMap = new Map(suppressions.map(s => [s.fingerprint, s]));
  const suppressed = findings.filter(f => suppressedIds.has(f.fingerprint));
  const active = findings.filter(f => !suppressedIds.has(f.fingerprint));

  // Apply filters
  const filtered = (showSuppressed ? findings : active).filter(f => {
    if (selectedSeverities.size > 0 && !selectedSeverities.has(f.severity)) return false;
    if (selectedPolicies.size > 0 && !selectedPolicies.has(f.ruleId)) return false;
    return true;
  });

  const hasFilters = selectedSeverities.size > 0 || selectedPolicies.size > 0;

  const visible = filtered;

  if (findings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-sm font-medium text-ink">No findings</p>
        <p className="mt-1 text-xs text-ink-muted">All resources passed this scan.</p>
      </div>
    );
  }

  return (
    <div>
      {/* Filter bar */}
      <div className="space-y-2.5 border-b border-border bg-surface-sunken px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Left: count + suppressed toggle */}
          <div className="flex flex-wrap items-center gap-3">
            <p className="shrink-0 text-[13px] font-medium text-ink">
              {hasFilters
                ? `${visible.length} of ${active.length} finding${active.length !== 1 ? 's' : ''}`
                : `${active.length} active finding${active.length !== 1 ? 's' : ''}`}
            </p>
            {suppressed.length > 0 && (
              <button
                type="button"
                onClick={() => setShowSuppressed(s => !s)}
                className="flex shrink-0 items-center gap-1.5 text-[13px] text-ink-2 transition-colors hover:text-ink"
              >
                {showSuppressed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                {showSuppressed ? 'Hide' : 'Show'} suppressed ({suppressed.length})
              </button>
            )}
          </div>

          {/* Right: actions */}
          <div className="flex items-center gap-1">
            {hasFilters && (
              <Button variant="ghost" size="xs" onClick={clearFilters}>
                <X className="size-3" />Clear filters
              </Button>
            )}
            {/* Only offer a bulk script when some visible finding actually carries steps —
                otherwise the panel renders an empty script. Reappears on its own once
                generated remediation lands. */}
            {visible.some(f => f.remediationSteps.length > 0) && (
              <Button variant="ghost" size="sm" onClick={() => setShowBulkScript(s => !s)}>
                <Terminal className="size-3.5" />
                {showBulkScript ? 'Hide script' : 'Generate script'}
              </Button>
            )}
            <ExportButton findings={visible} />
          </div>
        </div>

        {/* Filter controls row */}
        <div className="flex flex-wrap items-center gap-2">
          {SEV_ALL.map(s => (
            <SeverityChip
              key={s}
              severity={s}
              active={selectedSeverities.has(s)}
              onClick={() => toggleSeverity(s)}
            />
          ))}

          {policyOptions.length > 1 && (
            <ChecklistDropdown
              size="sm"
              label="Rule"
              options={policyOptions}
              selected={selectedPolicies}
              onToggle={togglePolicy}
              onClear={() => setSelectedPolicies(new Set())}
            />
          )}
        </div>
      </div>
      {showBulkScript && <BulkScriptPanel findings={visible.filter(f => !suppressions?.some(s => s.fingerprint === f.fingerprint && (!s.expiresAt || new Date(s.expiresAt) > new Date())))} />}
      {/* No max-height. The list runs to its full length and the page scrolls,
          instead of a second scrollbar appearing inside the first at an arbitrary
          65% of whatever screen the reader happens to have. */}
      <TableScroll>
        <Table style={{ tableLayout: 'fixed', width: isFlexible('finding') ? '100%' : 'max-content', minWidth: '100%' }}>
          <colgroup>
            <col style={{ width: 32 }} />
            <col style={{ width: colWidths.severity }} />
            <col style={isFlexible('finding') ? undefined : { width: colWidths.finding }} />
            <col style={{ width: colWidths.resource }} />
            <col style={{ width: colWidths.resourceGroup }} />
            <col style={{ width: colWidths.rule }} />
            <col style={{ width: 96 }} />
          </colgroup>
          <TableHeader>
            <TableRow>
              <TableHead shrink />
              <TableHead className="relative">Severity<ColumnResizeHandle onMouseDown={startResize('severity')} /></TableHead>
              <TableHead className="relative">Finding<ColumnResizeHandle onMouseDown={startResize('finding')} /></TableHead>
              <TableHead className="relative">Resource<ColumnResizeHandle onMouseDown={startResize('resource')} /></TableHead>
              <TableHead className="relative">Resource Group<ColumnResizeHandle onMouseDown={startResize('resourceGroup')} /></TableHead>
              <TableHead className="relative">Rule<ColumnResizeHandle onMouseDown={startResize('rule')} /></TableHead>
              <TableHead numeric>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((f) => (
              <FindingRow
                key={f.fingerprint}
                finding={f}
                suppression={suppMap.get(f.fingerprint)}
                onSuppress={onSuppress}
                onUnsuppress={onUnsuppress}
              />
            ))}
          </TableBody>
        </Table>
      </TableScroll>
    </div>
  );
}
