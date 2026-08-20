'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import type { WidgetSummary } from '@/lib/dashboard-data';
import { mergeWidgetFilters, buildSummaryParams, type WidgetFilters } from '@/lib/dashboard-filters';
import { buildScansHref, type ScansLinkOverrides } from '@/lib/scans-link';
import { dateWindowLabel, dateWindowPhrase } from '@/lib/date-window';
import type { StatMetric } from '@/lib/types';
import { Delta } from '@/components/dashboard/widgets/delta';
import { postureColor } from '@/components/dashboard/dashboard-constants';
import { useWidgetFetch } from '@/lib/hooks/use-widget-fetch';
import { WidgetUnavailable } from '@/components/dashboard/widgets/widget-unavailable';

// Metric → /scans Results-tab overrides. Metrics with no obvious equivalent filter (posture %,
// modules healthy, rules scanned) link to a plain Results tab scoped only by inherited filters.
function metricOverrides(metric: StatMetric): ScansLinkOverrides {
  switch (metric) {
    case 'total-findings':
      return { status: 'open' };
    case 'new-findings':
      return { status: 'new' };
    case 'fixed-findings':
      return { status: 'fixed' };
    case 'critical-findings':
      return { severity: 'critical' };
    case 'high-findings':
      return { severity: 'high' };
    default:
      return {};
  }
}

interface Config { metric: StatMetric; category?: string; policyIds?: string[] }
interface Props { config: Config; filters: WidgetFilters; refreshKey: number }

export function StatCardWidget({ config, filters, refreshKey }: Props) {
  const router = useRouter();
  const merged = useMemo(() => mergeWidgetFilters(filters, config as unknown as Record<string, unknown>), [filters, config]);
  const params = buildSummaryParams(merged).toString();
  const { data: summary, loading, failed, retry } = useWidgetFetch<WidgetSummary>(
    `/api/widgets/summary?${params}`,
    [refreshKey]
  );
  const dateWindowKey = JSON.stringify(merged.dateWindow);

  const { value, label, delta, deltaSuffix, deltaTitle, subtext, color } = useMemo(() => {
    const fallback = { value: '—', label: '', delta: null as number | null, deltaSuffix: '%', deltaTitle: undefined as string | undefined, subtext: 'No data', color: 'var(--color-ink-faint)' };
    if (!summary) return fallback;
    const { current, deltaPct, baseline, perCategory } = summary;
    const windowLabel = dateWindowLabel(merged.dateWindow);
    const windowPhrase = dateWindowPhrase(merged.dateWindow);

    switch (config.metric) {
      case 'posture-pct':
        return {
          value: current.pct !== null ? `${current.passingRules} of ${current.totalRules}` : '—',
          label: 'checks passing',
          delta: deltaPct,
          deltaSuffix: '%',
          deltaTitle: baseline?.date ? `score today vs baseline since ${baseline.date}` : undefined,
          subtext: current.pct === null
            ? 'no checks enabled'
            : current.unknownRules > 0
              ? `${current.unknownRules} unknown · ${current.pct}%`
              : `${current.pct}%`,
          color: postureColor(current.pct),
        };
      case 'total-findings':
        return {
          value: String(current.activeFindings),
          label: 'open findings',
          // Plain new/fixed counts instead of a signed net delta — a single +/-N number forces
          // the reader to reverse-engineer two hidden numbers (and doesn't explain moves from
          // suppression/rule changes either); showing both counts directly needs no decoding and
          // matches Scans' own new-findings/fixed-findings numbers exactly.
          delta: null,
          deltaSuffix: '',
          deltaTitle: undefined,
          subtext: `${current.newInWindow} new · ${current.fixedInWindow} fixed ${windowPhrase}`,
          color: 'var(--color-ink)',
        };
      case 'critical-findings':
        return {
          value: String(current.severityCounts.critical ?? 0),
          label: 'critical',
          delta: null,
          deltaSuffix: '',
          deltaTitle: undefined,
          subtext: 'require immediate action',
          color: (current.severityCounts.critical ?? 0) > 0 ? 'var(--color-sev-critical)' : 'var(--color-ink-faint)',
        };
      case 'high-findings':
        return {
          value: String(current.severityCounts.high ?? 0),
          label: 'high severity',
          delta: null,
          deltaSuffix: '',
          deltaTitle: undefined,
          subtext: 'findings',
          color: (current.severityCounts.high ?? 0) > 0 ? 'var(--color-sev-high)' : 'var(--color-ink-faint)',
        };
      case 'rules-scanned':
        return {
          value: String(current.totalRules),
          label: 'rules scanned',
          delta: null,
          deltaSuffix: '',
          deltaTitle: undefined,
          subtext: `${current.passingRules} passing`,
          color: 'var(--color-ink)',
        };
      case 'modules-healthy': {
        const scanned = perCategory.filter(m => m.lastScanAt !== null);
        const healthy = scanned.filter(m => m.activeFindings === 0).length;
        return {
          value: `${healthy}/${scanned.length}`,
          label: 'categories healthy',
          delta: null,
          deltaSuffix: '',
          deltaTitle: undefined,
          subtext: 'categories with zero open findings',
          color: healthy === scanned.length && scanned.length > 0 ? 'var(--color-ink)' : 'var(--color-status-warn)',
        };
      }
      case 'new-findings':
        return {
          value: String(current.newInWindow),
          label: `new findings (${windowLabel})`,
          delta: null,
          deltaSuffix: '',
          deltaTitle: undefined,
          subtext: `first seen ${windowPhrase}`,
          color: current.newInWindow > 0 ? 'var(--color-sev-critical)' : 'var(--color-ink-faint)',
        };
      case 'fixed-findings':
        return {
          value: String(current.fixedInWindow),
          label: `fixed findings (${windowLabel})`,
          delta: null,
          deltaSuffix: '',
          deltaTitle: undefined,
          subtext: `resolved ${windowPhrase}`,
          color: current.fixedInWindow > 0 ? 'var(--color-status-ok)' : 'var(--color-ink-faint)',
        };
      default:
        return fallback;
    }
  }, [config.metric, summary, dateWindowKey, merged.ruleIds]);

  const href = useMemo(() => buildScansHref(merged, metricOverrides(config.metric)), [merged, config.metric]);

  if (loading) return <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-ink-muted" /></div>;

  if (failed) return <WidgetUnavailable onRetry={retry} />;

  return (
    <button
      type="button"
      onClick={() => router.push(href)}
      className="flex h-full w-full cursor-pointer flex-col items-start justify-center gap-1 px-5 py-4 text-left transition-colors hover:bg-surface-hover"
      title="View in Scans"
    >
      <span className="numeral-grid text-4xl font-bold leading-none" style={{ color }}>{value}</span>
      <span className="mt-1 text-sm font-medium text-ink-2">{label}</span>
      {delta !== null && <Delta value={delta} suffix={deltaSuffix} title={deltaTitle} neutralLabel="flat" />}
      <span className="mt-0.5 text-xs text-ink-muted">{subtext}</span>
    </button>
  );
}
