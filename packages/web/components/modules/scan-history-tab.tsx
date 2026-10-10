'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardAction } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Select } from '@/components/ui/select';
import { RunStatusDot } from '@/components/scans/run-status-dot';
import { SnapshotScreen } from '@/components/scans/snapshot-screen';
import { CategoryBadge } from '@/components/findings/category-badge';
import { CompareScreen } from '@/components/scans/compare-screen';
import { describeTarget } from '@/lib/target-describe';
import { emptyCompareQuery, type CompareQuery } from '@/lib/compare-query';
import { emptySnapshotQuery, type SnapshotQuery } from '@/lib/snapshot-query';
import type { Category, Rule, ScanMeta, Severity } from '@/lib/types';
import type { ScheduleRun } from '@/lib/schedule-runs';
import { Activity, ArrowLeft } from 'lucide-react';

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export interface ScanHistoryTabProps {
  categories: Category[];
  rules: Rule[];
  runs: ScheduleRun[];
  runDetail?: { run: ScheduleRun; scans: ScanMeta[] } | null;
  /** The scan a `?scan=` link names. The screen reads its findings from the server a page at a time. */
  snapshotScanId?: string;
  /** What the address asks of that scan: filters, search and page. */
  snapshotQuery?: SnapshotQuery;
  /** Counts the navigations the snapshot did not make itself, each of which starts it again from the address. */
  snapshotRestarts?: number;
  /** Reports the query the snapshot is about to write to the address. */
  onSnapshotUrlWrite?: (query: string) => void;
  compareCategorySlug?: string;
  compareCategoryScans?: ScanMeta[];
  /** The two scans a `?compare=` link names, in the order it wrote them. The screen reads the compare from the server. */
  compareIds?: [string, string];
  /** What the address asks of that compare: the side and the page. */
  compareQuery?: CompareQuery;
  /** Counts the navigations the compare did not make itself, each of which starts it again from the address. */
  compareRestarts?: number;
  /** Reports the query the compare is about to write to the address. */
  onCompareUrlWrite?: (query: string) => void;
}

export function ScanHistoryTab({
  categories, rules, runs, runDetail, snapshotScanId, snapshotQuery, snapshotRestarts = 0, onSnapshotUrlWrite,
  compareCategorySlug, compareCategoryScans, compareIds, compareQuery, compareRestarts = 0, onCompareUrlWrite,
}: ScanHistoryTabProps) {
  const router = useRouter();
  // Driven entirely by the `compareCategory` URL param (like the Library `?section=` pattern) —
  // not local state — so navigating away (Cancel) or picking a different category always
  // reflects what the server actually fetched, instead of an independent client value that can
  // drift from the props once they change.
  const pickedCategory = compareCategorySlug ?? '';
  const [pickedScans, setPickedScans] = useState<Set<string>>(new Set());

  // Reset-on-external-prop-change, not derivable render state.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setPickedScans(new Set()); }, [pickedCategory]);

  const categoryById = useMemo(() => new Map(categories.map(c => [c.id, c])), [categories]);
  const ruleById = useMemo(() => new Map(rules.map(r => [r.id, r])), [rules]);

  // ---- Compare result ----
  if (compareIds) {
    return (
      <CompareScreen
        key={`${compareIds.join('..')}-${compareRestarts}`}
        ids={compareIds}
        initialQuery={compareQuery ?? emptyCompareQuery()}
        backHref="/scans?tab=history"
        onUrlWrite={onCompareUrlWrite}
      />
    );
  }

  // ---- Snapshot (one category's scan within a run), read from the server a page at a time ----
  if (snapshotScanId) {
    return (
      <SnapshotScreen
        key={`${snapshotScanId}-${snapshotRestarts}`}
        scanId={snapshotScanId}
        initialQuery={snapshotQuery ?? emptySnapshotQuery()}
        categories={categories}
        backHref={runDetail ? `/scans?tab=history&run=${runDetail.run.id}` : '/scans?tab=history'}
        onUrlWrite={onSnapshotUrlWrite}
      />
    );
  }

  // ---- Compare picker (pick a category, then two of its recent scans) ----
  if (compareCategorySlug) {
    const scans = compareCategoryScans ?? [];
    return (
      <Card>
        <CardHeader>
          <CardTitle>Compare scans · {categoryById.get(pickedCategory)?.label ?? pickedCategory}</CardTitle>
          <CardAction>
            <Link href="/scans?tab=history" className="text-xs text-ink-2 hover:text-ink">Cancel</Link>
          </CardAction>
        </CardHeader>
        {scans.length < 2 ? (
          <p className="py-10 text-center text-sm text-ink-muted">Not enough scan history for this category yet.</p>
        ) : (
          <>
            <div className="divide-y divide-border">
              {scans.map(scan => (
                <label key={scan.id} className="flex items-center gap-3 px-6 py-3 hover:bg-surface-hover cursor-pointer">
                  <input
                    type="checkbox"
                    checked={pickedScans.has(scan.id)}
                    onChange={() => setPickedScans(prev => {
                      const next = new Set(prev);
                      if (next.has(scan.id)) { next.delete(scan.id); return next; }
                      if (next.size >= 2) return next;
                      next.add(scan.id);
                      return next;
                    })}
                    disabled={!pickedScans.has(scan.id) && pickedScans.size >= 2}
                    className="size-3.5 shrink-0 accent-ink"
                  />
                  <Activity className="size-4 text-ink-muted" />
                  <span className="text-sm text-ink">{formatDate(scan.startedAt)}</span>
                  <div className="flex gap-1.5 ml-auto">
                    {SEVERITY_ORDER.filter(s => scan.counts[s] > 0).map(s => (
                      <Badge key={s} variant="outline" className="text-xs">{scan.counts[s]} {s}</Badge>
                    ))}
                  </div>
                </label>
              ))}
            </div>
            <div className="px-6 py-3 border-t border-border flex items-center justify-between">
              <span className="text-xs text-ink-muted">{pickedScans.size} of 2 selected</span>
              <Link
                href={pickedScans.size === 2 ? `/scans?tab=history&compare=${[...pickedScans].join('..')}` : '#'}
                aria-disabled={pickedScans.size !== 2}
                className={pickedScans.size === 2 ? '' : 'pointer-events-none opacity-50'}
              >
                <Button size="sm" disabled={pickedScans.size !== 2}>Compare selected</Button>
              </Link>
            </div>
          </>
        )}
      </Card>
    );
  }

  // ---- Run detail (per-category scans belonging to one execution) ----
  if (runDetail) {
    const { run, scans } = runDetail;
    return (
      <div className="space-y-4">
        <Link href="/scans?tab=history" className="inline-flex items-center gap-1.5 text-sm font-medium text-ink hover:underline">
          <ArrowLeft className="size-3.5" /> Back to history
        </Link>
        <Card>
          <CardHeader>
            <CardTitle>{run.triggeredBy === 'schedule' ? 'Scheduled run' : 'Manual run'}</CardTitle>
          </CardHeader>
          <div className="px-6 py-4 space-y-1 border-b border-border text-sm">
            <p className="text-ink">Started {formatDate(run.startedAt)}</p>
            <p className="text-ink">Target: {describeTarget({ targetType: run.targetType ?? 'categories', targetValues: run.targetValues.length ? run.targetValues : run.categories }, categoryById, ruleById)}</p>
            <p className="text-ink">{run.totalFindings} total findings · {run.newFindings} new</p>
          </div>
          <div className="divide-y divide-border">
            {scans.map(scan => (
              <div key={scan.id}>
                <Link
                  href={`/scans?tab=history&run=${run.id}&scan=${scan.id}`}
                  className="flex items-center justify-between px-6 py-3.5 hover:bg-surface-hover transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <Activity className="size-4 text-ink-muted" />
                    <CategoryBadge id={scan.module} categories={categories} />
                    {scan.coverage === 'partial' && <Badge variant="warning" className="text-xs">Partial</Badge>}
                  </div>
                  <div className="flex gap-1.5">
                    {SEVERITY_ORDER.filter(s => scan.counts[s] > 0).map(s => (
                      <Badge key={s} variant="outline" className="text-xs">{scan.counts[s]} {s}</Badge>
                    ))}
                  </div>
                </Link>
                {scan.coverage === 'partial' && (
                  <div className="px-6 pb-3.5 -mt-1">
                    <Callout tone="warn">
                      <span>
                        {scan.incompleteRules.length} rule{scan.incompleteRules.length === 1 ? '' : 's'} did not
                        complete — findings from a prior scan for {scan.incompleteRules.length === 1 ? 'it' : 'them'} were
                        left as-is rather than marked fixed:{' '}
                        {scan.incompleteRules.map((r, i) => (
                          <span key={r.ruleId}>
                            {i > 0 && ', '}
                            {r.ruleName} ({
                              r.status === 'capped' ? 'result was capped'
                                : r.status === 'invalid' ? 'result had rows with no resource id'
                                : 'query failed'
                            })
                          </span>
                        ))}
                      </span>
                    </Callout>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      </div>
    );
  }

  // ---- Unified run list ----
  if (runs.length === 0) {
    return <p className="py-10 text-center text-sm text-ink-muted">No scans have run yet.</p>;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Run History ({runs.length})</CardTitle>
        <CardAction>
          <div className="w-52">
            <Select
              value={pickedCategory}
              onValueChange={v => router.push(v ? `/scans?tab=history&compareCategory=${v}` : '/scans?tab=history')}
              options={categories.map(c => ({ value: c.id, label: c.label }))}
              placeholder="Compare scans in…"
              size="sm"
              aria-label="Compare scans in category"
            />
          </div>
        </CardAction>
      </CardHeader>
      <div className="divide-y divide-border">
        {runs.map((run, i) => (
          <div key={run.id}>
            <Link
              href={`/scans?tab=history&run=${run.id}`}
              className="flex items-center justify-between px-6 py-3.5 hover:bg-surface-hover transition-colors"
            >
              {/* Fixed-width slots, not a gap-separated flow. A shorter date ("31 Jul" vs
                  "10 Aug") or the Latest badge on the first row shifted every following item,
                  so no two rows in the list lined up. The Latest slot stays reserved on the
                  rows that don't have one. */}
              <div className="flex min-w-0 items-center gap-3">
                <RunStatusDot status={run.status} />
                <span className="numeral-grid w-28 shrink-0 text-sm text-ink">{formatDate(run.startedAt)}</span>
                <span className="w-[62px] shrink-0">
                  {i === 0 && <Badge variant="secondary" className="text-xs">Latest</Badge>}
                </span>
                <span className="w-24 shrink-0">
                  <Badge variant="outline" className="text-xs">{run.triggeredBy === 'schedule' ? 'Scheduled' : 'Manual'}</Badge>
                </span>
                <span className="truncate text-sm text-ink">
                  {describeTarget({ targetType: run.targetType ?? 'categories', targetValues: run.targetValues.length ? run.targetValues : run.categories }, categoryById, ruleById)}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="numeral-grid text-sm font-medium text-ink">{run.totalFindings} findings</span>
                {run.newFindings > 0 && <Badge variant="destructive" className="text-xs">+{run.newFindings} new</Badge>}
              </div>
            </Link>
            {run.error && (run.status === 'partial' || run.status === 'error') && (
              <div className="px-6 pb-3.5 -mt-1">
                <Callout tone={run.status === 'error' ? 'error' : 'warn'}>
                  <span className="break-words">{run.error}</span>
                </Callout>
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
