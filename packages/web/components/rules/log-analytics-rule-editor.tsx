'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Callout, CalloutPanel } from '@/components/ui/callout';
import { Input, Label, Textarea } from '@/components/ui/input';
import { HelpCircle, Play } from 'lucide-react';
import type { LogAnalyticsQuery } from '@/lib/types';

interface ValidateResult { count: number; truncated: boolean; samples: Record<string, unknown>[] }

interface LogAnalyticsRuleEditorProps {
  value: LogAnalyticsQuery;
  onChange: (value: LogAnalyticsQuery) => void;
  /** Gates the fields themselves. Validate stays available either way — testing a saved
   *  query live is not an editing action, same precedent as GraphRuleEditor's Validate button. */
  readOnly?: boolean;
}

export function LogAnalyticsRuleEditor({ value, onChange, readOnly }: LogAnalyticsRuleEditorProps) {
  const [validating, setValidating] = useState(false);
  const [validateResult, setValidateResult] = useState<ValidateResult | { error: string } | null>(null);

  async function handleValidate() {
    setValidating(true);
    setValidateResult(null);
    try {
      const res = await fetch('/api/rules/validate-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logsQuery: value }),
      });
      const data = await res.json() as ValidateResult | { error: string };
      setValidateResult(data);
    } catch (e) {
      setValidateResult({ error: String(e) });
    } finally { setValidating(false); }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2.5 min-w-0">
          <CardTitle>Log Analytics query</CardTitle>
          {!readOnly && (
            <span className="label-grid shrink-0 whitespace-nowrap border border-border bg-surface-sunken px-1.5 py-0.5">Editable</span>
          )}
        </div>
        <Button variant="outline" size="sm" disabled={validating || !value.kql.trim()} onClick={() => { void handleValidate(); }}>
          <Play className="h-3.5 w-3.5" />
          {validating ? 'Testing…' : 'Validate'}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {!readOnly && (
          <p className="text-[13px] text-ink-2">
            Runs against your configured Log Analytics workspace. Write your own <span className="font-mono text-xs">TimeGenerated</span> filter — the time window below is display metadata only, never spliced into the query.
          </p>
        )}
        <div>
          <Label className="mb-1">KQL query</Label>
          {readOnly ? (
            <pre className="whitespace-pre-wrap border border-border bg-surface-sunken px-3 py-2.5 font-mono text-xs leading-relaxed text-ink">{value.kql}</pre>
          ) : (
            <Textarea
              value={value.kql}
              onChange={e => onChange({ ...value, kql: e.target.value })}
              rows={8}
              spellCheck={false}
              placeholder="SigninLogs | where ResultType != 0"
              className="resize-y bg-surface-sunken px-3 py-2.5 font-mono text-xs leading-relaxed"
            />
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label className="mb-1 flex items-center gap-1">
              Time window (days)
              <span title="How many days of occurrences this rule represents, e.g. &quot;in the last 30 days&quot;. Doesn't change the query — write your own TimeGenerated filter to match.">
                <HelpCircle className="size-3.5 text-ink-faint" />
              </span>
            </Label>
            <Input
              type="number" min={1} max={730}
              value={value.timeWindowDays}
              onChange={e => onChange({ ...value, timeWindowDays: Number(e.target.value) })}
              disabled={readOnly}
            />
          </div>
          <div>
            <Label className="mb-1 flex items-center gap-1">
              Dimension key field
              <span title="Optional. A column name whose per-row value keys a separate finding, e.g. UserId for one finding per user. Leave blank to collapse every occurrence onto one finding.">
                <HelpCircle className="size-3.5 text-ink-faint" />
              </span>
            </Label>
            <Input
              value={value.dimensionKeyField ?? ''}
              onChange={e => onChange({ ...value, dimensionKeyField: e.target.value || undefined })}
              disabled={readOnly}
              placeholder="e.g. UserId"
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
                ? `Matched more than ${validateResult.count.toLocaleString()} rows`
                : `Valid. Matched ${validateResult.count} row${validateResult.count !== 1 ? 's' : ''} (showing up to 5)`}
            >
              {validateResult.samples.length > 0 && (
                <div className="scroll-x space-y-2">
                  {validateResult.samples.map((row, i) => (
                    <div key={i} className="border border-current/10 px-2.5 py-1.5 font-mono text-xs">
                      {Object.entries(row).map(([k, v]) => (
                        <div key={k} className="flex gap-1.5">
                          <span className="shrink-0 text-ink-muted">{k}:</span>
                          <span className="truncate text-ink">{String(v)}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </CalloutPanel>
          )
        )}
      </CardContent>
    </Card>
  );
}
