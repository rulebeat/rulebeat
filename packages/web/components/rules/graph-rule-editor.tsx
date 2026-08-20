'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Callout, CalloutPanel } from '@/components/ui/callout';
import { Input, Label } from '@/components/ui/input';
import { Select, type SelectOption } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { HelpCircle, Play, Plus, Trash2 } from 'lucide-react';
import { GRAPH_RESOURCE_PATHS } from '@/lib/kql';
import type { GraphExpandConfig, GraphQuery, GraphResourcePath, GraphSeverityBand, Severity } from '@/lib/types';

const GRAPH_PATH_LABELS: Record<GraphResourcePath, string> = {
  users: 'Users',
  groups: 'Groups',
  applications: 'Applications',
  servicePrincipals: 'Service principals',
  directoryRoles: 'Directory roles',
  devices: 'Devices',
  administrativeUnits: 'Administrative units',
};

const GRAPH_PATH_OPTIONS: readonly SelectOption[] =
  GRAPH_RESOURCE_PATHS.map(p => ({ value: p, label: GRAPH_PATH_LABELS[p] }));

const SEVERITY_OPTIONS: readonly SelectOption[] = (['critical', 'high', 'medium', 'low', 'info'] as Severity[])
  .map(s => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }));

function defaultExpand(): GraphExpandConfig {
  return { arrayField: '', dateField: '', itemIdField: '', resourceType: '', bands: [{ maxDays: 30, severity: 'medium' }] };
}

interface ValidateResult { count: number; truncated: boolean; samples: { id: string; displayName: string }[] }

interface GraphRuleEditorProps {
  value: GraphQuery;
  onChange: (value: GraphQuery) => void;
  /** Gates the fields themselves. Validate stays available either way — testing a saved
   *  query live is not an editing action, same precedent as the KQL pane's Validate button. */
  readOnly?: boolean;
}

export function GraphRuleEditor({ value, onChange, readOnly }: GraphRuleEditorProps) {
  const [validating, setValidating] = useState(false);
  const [validateResult, setValidateResult] = useState<ValidateResult | { error: string } | null>(null);

  async function handleValidate() {
    setValidating(true);
    setValidateResult(null);
    try {
      const res = await fetch('/api/rules/validate-graph', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ graphQuery: value }),
      });
      const data = await res.json() as ValidateResult | { error: string };
      setValidateResult(data);
    } catch (e) {
      setValidateResult({ error: String(e) });
    } finally { setValidating(false); }
  }

  const expand = value.expand;

  function setExpand(next: GraphExpandConfig | undefined) {
    onChange({ ...value, expand: next });
    setValidateResult(null);
  }

  function updateBand(i: number, patch: Partial<GraphSeverityBand>) {
    if (!expand) return;
    setExpand({ ...expand, bands: expand.bands.map((b, j) => j === i ? { ...b, ...patch } : b) });
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2.5 min-w-0">
            <CardTitle>Directory query</CardTitle>
            {!readOnly && (
              <span className="label-grid shrink-0 whitespace-nowrap border border-border bg-surface-sunken px-1.5 py-0.5">Editable</span>
            )}
          </div>
          <Button variant="outline" size="sm" disabled={validating} onClick={() => { void handleValidate(); }}>
            <Play className="h-3.5 w-3.5" />
            {validating ? 'Testing…' : 'Validate'}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {!readOnly && (
            <p className="text-[13px] text-ink-2">
              Queries Microsoft Graph directly — this is a directory object, not an Azure resource, so there is no ARG scope or resource type filter here.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="mb-1">Resource type</Label>
              <Select
                value={value.path}
                onValueChange={v => onChange({ ...value, path: v as GraphResourcePath })}
                disabled={readOnly}
                options={GRAPH_PATH_OPTIONS}
                aria-label="Resource type"
              />
            </div>
            <div>
              <Label className="mb-1 flex items-center gap-1">
                Filter
                <span title="An OData $filter expression, e.g. accountEnabled eq false. Leave blank to match every object of this type.">
                  <HelpCircle className="size-3.5 text-ink-faint" />
                </span>
              </Label>
              <Input
                value={value.filter ?? ''}
                onChange={e => onChange({ ...value, filter: e.target.value || undefined })}
                disabled={readOnly}
                placeholder="e.g. accountEnabled eq false"
                className="font-mono text-xs"
              />
            </div>
          </div>

          {validateResult && (
            'error' in validateResult ? (
              <Callout tone="error" title="Query error">
                <p className="font-mono">{validateResult.error}</p>
              </Callout>
            ) : (
              <CalloutPanel
                tone="success"
                title={validateResult.truncated
                  ? `Matched more than ${validateResult.count.toLocaleString()} objects`
                  : `Valid. Matched ${validateResult.count} object${validateResult.count !== 1 ? 's' : ''} (showing up to 5)`}
              >
                {validateResult.samples.length > 0 && (
                  <div className="scroll-x">
                    <table className="w-full border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-current/15">
                          <th className="label-grid whitespace-nowrap px-3 py-1.5 text-left">Display name</th>
                          <th className="label-grid whitespace-nowrap px-3 py-1.5 text-left">Id</th>
                        </tr>
                      </thead>
                      <tbody>
                        {validateResult.samples.map((s, i) => (
                          <tr key={i} className="border-b border-current/10 last:border-0">
                            <td className="max-w-[240px] truncate px-3 py-1.5 font-medium text-ink">{s.displayName}</td>
                            <td className="px-3 py-1.5 font-mono text-xs text-ink">{s.id}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CalloutPanel>
            )
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-1.5 min-w-0">
            <CardTitle className="text-sm">Flag expiring items</CardTitle>
            <span title="Optional. Instead of flagging the object itself, look inside an array field on it (such as credentials) and flag items approaching a date, with severity that rises as the date gets closer.">
              <HelpCircle className="size-3.5 text-ink-faint" />
            </span>
          </div>
          {!readOnly && (
            <Switch
              checked={!!expand}
              onCheckedChange={checked => setExpand(checked ? defaultExpand() : undefined)}
              title={expand ? 'Flag the object itself instead' : 'Flag items inside an array field instead'}
            />
          )}
        </CardHeader>
        <CardContent>
          {!expand ? (
            <p className="py-1 text-xs text-ink-2">
              {readOnly
                ? 'This rule flags the object itself.'
                : 'Off — this rule flags the object itself. Turn on to flag items inside an array field instead, such as expiring credentials.'}
            </p>
          ) : (
            <div className="space-y-3">
              {!readOnly && (
                <p className="text-xs text-ink-2">
                  Example, for an Application&apos;s client secrets: array field{' '}
                  <span className="font-mono text-ink">passwordCredentials</span>, date field{' '}
                  <span className="font-mono text-ink">endDateTime</span>, item id field{' '}
                  <span className="font-mono text-ink">keyId</span>, item label{' '}
                  <span className="font-mono text-ink">Client secret</span>. RuleBeat checks each
                  item&apos;s date against today and flags it once it falls inside a severity band below.
                </p>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label className="mb-1 flex items-center gap-1">
                    Array field
                    <span title="The array property on the object that holds the items to check — e.g. an Application's list of client secrets.">
                      <HelpCircle className="size-3.5 text-ink-faint" />
                    </span>
                  </Label>
                  <Input
                    value={expand.arrayField}
                    onChange={e => setExpand({ ...expand, arrayField: e.target.value })}
                    disabled={readOnly}
                    placeholder="e.g. passwordCredentials"
                    className="font-mono text-xs"
                  />
                </div>
                <div>
                  <Label className="mb-1 flex items-center gap-1">
                    Date field
                    <span title="The date property inside each item, checked against today to decide how soon it expires.">
                      <HelpCircle className="size-3.5 text-ink-faint" />
                    </span>
                  </Label>
                  <Input
                    value={expand.dateField}
                    onChange={e => setExpand({ ...expand, dateField: e.target.value })}
                    disabled={readOnly}
                    placeholder="e.g. endDateTime"
                    className="font-mono text-xs"
                  />
                </div>
                <div>
                  <Label className="mb-1 flex items-center gap-1">
                    Item id field
                    <span title="The property inside each item that uniquely identifies it, so RuleBeat can track the same item across scans.">
                      <HelpCircle className="size-3.5 text-ink-faint" />
                    </span>
                  </Label>
                  <Input
                    value={expand.itemIdField}
                    onChange={e => setExpand({ ...expand, itemIdField: e.target.value })}
                    disabled={readOnly}
                    placeholder="e.g. keyId"
                    className="font-mono text-xs"
                  />
                </div>
                <div>
                  <Label className="mb-1 flex items-center gap-1">
                    Item label
                    <span title="A human-readable name for what each item is, shown on the finding — not a field name, just a word.">
                      <HelpCircle className="size-3.5 text-ink-faint" />
                    </span>
                  </Label>
                  <Input
                    value={expand.resourceType}
                    onChange={e => setExpand({ ...expand, resourceType: e.target.value })}
                    disabled={readOnly}
                    placeholder="e.g. Client secret"
                    className="text-xs"
                  />
                </div>
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <Label>Severity by days remaining</Label>
                  {!readOnly && (
                    <Button
                      variant="ghost" size="xs"
                      onClick={() => setExpand({ ...expand, bands: [...expand.bands, { maxDays: 30, severity: 'low' }] })}
                    >
                      <Plus className="size-3" />Add band
                    </Button>
                  )}
                </div>
                <div className="space-y-2">
                  {expand.bands.length === 0 && <p className="px-1 text-xs text-ink-muted">No severity bands. Add one above.</p>}
                  {expand.bands.map((band, i) => (
                    <div key={i} className="flex items-center gap-2 border border-border bg-surface-sunken p-2.5">
                      <span className="shrink-0 text-xs text-ink-2">Within</span>
                      <Input
                        type="number" min={0} inputSize="sm"
                        value={band.maxDays}
                        onChange={e => updateBand(i, { maxDays: Number(e.target.value) })}
                        disabled={readOnly}
                        className="w-20"
                      />
                      <span className="shrink-0 text-xs text-ink-2">days →</span>
                      <Select
                        size="sm"
                        className="w-32 shrink-0 text-xs"
                        aria-label="Severity"
                        value={band.severity}
                        onValueChange={v => updateBand(i, { severity: v as Severity })}
                        options={SEVERITY_OPTIONS}
                        disabled={readOnly}
                      />
                      {!readOnly && (
                        <Button
                          variant="ghost" size="icon-sm" className="ml-auto shrink-0"
                          onClick={() => setExpand({ ...expand, bands: expand.bands.filter((_, j) => j !== i) })}
                          disabled={expand.bands.length <= 1}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
                <p className="mt-1.5 text-xs text-ink-muted">Bands are checked in order, tightest first — the first one whose day count covers the item wins.</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
