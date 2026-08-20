'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardAction } from '@/components/ui/card';
import { SeverityBadge } from '@/components/findings/severity-badge';
import { ExportButton } from '@/components/findings/export-button';
import { cn } from '@/lib/utils';
import type { ScanSummary, Finding } from '@/lib/types';
import { ArrowLeft } from 'lucide-react';

interface ScanCompareProps {
  scanA: ScanSummary;
  scanB: ScanSummary;
  categorySlug: string;
  /** Where the "Back" link returns to. Defaults to the category's Run History tab. */
  backHref?: string;
}

type Tab = 'added' | 'fixed' | 'persisted';

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function ScanCompare({ scanA, scanB, categorySlug, backHref }: ScanCompareProps) {
  const [older, newer] = new Date(scanA.startedAt) <= new Date(scanB.startedAt) ? [scanA, scanB] : [scanB, scanA];
  const [tab, setTab] = useState<Tab>('added');

  const olderFps = new Set(older.findings.map(f => f.fingerprint));
  const newerFps = new Set(newer.findings.map(f => f.fingerprint));
  const added = newer.findings.filter(f => !olderFps.has(f.fingerprint));
  const fixed = older.findings.filter(f => !newerFps.has(f.fingerprint));
  const persisted = newer.findings.filter(f => olderFps.has(f.fingerprint));

  const lists: Record<Tab, Finding[]> = { added, fixed, persisted };
  const activeList = lists[tab];

  return (
    <div className="space-y-6">
      <div>
        <Link href={backHref ?? `/scans?category=${categorySlug}&tab=history`} className="inline-flex items-center gap-1.5 text-sm font-medium text-ink hover:underline">
          <ArrowLeft className="size-3.5" /> Back to history
        </Link>
        <h2 className="mt-2 font-heading text-lg font-semibold text-ink">Comparing scans</h2>
        <p className="numeral-grid text-sm text-ink-2">{formatDate(older.startedAt)} → {formatDate(newer.startedAt)}</p>
      </div>

      {/* Three tiles that are also the tab control. The tile itself stays neutral so
          the only colour on screen is the count: new findings are the bad news, fixed
          ones the good news, and findings that simply carried over are neither.
          Selection is marked by weight and ground, not by another hue. */}
      <div className="grid grid-cols-3 gap-4">
        {([
          ['added', `+${added.length}`, 'Added', 'text-sev-critical'],
          ['fixed', `-${fixed.length}`, 'Fixed', 'text-status-ok'],
          ['persisted', `${persisted.length}`, 'Persisted', 'text-ink'],
        ] as [Tab, string, string, string][]).map(([key, value, label, numeralClass]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            aria-pressed={tab === key}
            className={cn(
              'border px-4 py-4 text-center transition-colors',
              tab === key
                ? 'border-ink bg-surface-sunken'
                : 'border-border bg-surface hover:border-rule-strong',
            )}
          >
            <div className={cn('numeral-grid mb-1 text-2xl font-bold leading-none', numeralClass)}>{value}</div>
            <div className={cn('text-xs font-medium', tab === key ? 'text-ink' : 'text-ink-2')}>{label}</div>
          </button>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="capitalize">{tab} findings ({activeList.length})</CardTitle>
          <CardAction>
            <ExportButton findings={activeList} />
          </CardAction>
        </CardHeader>
        {activeList.length === 0 ? (
          <p className="py-10 text-center text-sm text-ink-muted">No {tab} findings between these two scans</p>
        ) : (
          <div className="divide-y divide-border">
            {activeList.map(f => (
              <div key={f.fingerprint} className="flex items-center justify-between gap-4 px-6 py-3.5">
                <div className="flex items-center gap-3 min-w-0">
                  <SeverityBadge severity={f.severity} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{f.title}</p>
                    <p className="truncate text-xs text-ink">
                      {f.resourceName}{f.resourceGroup ? ` · ${f.resourceGroup}` : ''}
                    </p>
                  </div>
                </div>
                <Link href={`/scans?category=all&tab=results&ruleId=${encodeURIComponent(f.ruleId)}`} className="shrink-0 text-xs font-medium text-ink hover:underline">
                  View in Findings →
                </Link>
              </div>
            ))}
          </div>
        )}
      </Card>

      <p className="text-xs text-ink-muted">
        Compare depth is bounded by scan history retention (up to 90 scans per category).
      </p>
    </div>
  );
}
