'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import type { WidgetSummary } from '@/lib/dashboard-data';
import { mergeWidgetFilters, buildSummaryParams, type WidgetFilters } from '@/lib/dashboard-filters';
import { buildScansHref, type ScansLinkOverrides } from '@/lib/scans-link';
import { dateWindowLabel, dateWindowPhrase } from '@/lib/date-window';
import type { StatMetric } from '@/lib/types';
import { PostureDelta } from '@/components/dashboard/widgets/posture-delta';
import { postureColor } from '@/components/dashboard/dashboard-constants';
import { postureEmptyReason } from '@/lib/widget-limits';
import { useReportWidgetNotes } from '@/lib/hooks/use-widget-notes';
import { useWidgetFetch } from '@/lib/hooks/use-widget-fetch';
import { WidgetUnavailable } from '@/components/dashboard/widgets/widget-unavailable';

// Metric → /scans Results-tab overrides. Metrics with no obvious equivalent filter (posture %,
// modules healthy, rules counted) link to a plain Results tab scoped only by inherited filters.
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
  // The metrics that read the posture formula carry its limits; the finding counts do not.
  const countsRules = config.metric === 'posture-pct' || config.metric === 'rules-scanned' || config.metric === 'modules-healthy';
  useReportWidgetNotes(countsRules && !loading && !failed && summary ? summary.postureNotes : []);

  const { value, label, subtext, color } = useMemo(() => {
    const fallback = { value: '-', label: '', subtext: 'No data', color: 'var(--color-ink-faint)' };
    if (!summary) return fallback;
    const { current, perCategory } = summary;
    const windowLabel = dateWindowLabel(merged.dateWindow);
    const windowPhrase = dateWindowPhrase(merged.dateWindow);

    switch (config.metric) {
      case 'posture-pct':
        return {
          value: `${current.passingRules} of ${current.totalRules}`,
          label: summary.measure ?? 'checks passing',
          subtext: current.unknownRules > 0
            ? `${current.unknownRules} unknown · ${current.pct}%`
            : `${current.pct}%`,
          color: postureColor(current.pct),
        };
      case 'total-findings':
        return {
          value: String(current.activeFindings),
          label: 'open findings',
          // Plain new/fixed counts instead of a signed net delta. A single +/-N number forces
          // the reader to reverse-engineer two hidden numbers (and doesn't explain moves from
          // suppression/rule changes either); showing both counts directly needs no decoding and
          // matches Scans' own new-findings/fixed-findings numbers exactly.
          subtext: `${current.newInWindow} new · ${current.fixedInWindow} fixed ${windowPhrase}`,
          color: 'var(--color-ink)',
        };
      case 'critical-findings':
        return {
          value: String(current.severityCounts.critical ?? 0),
          label: 'critical',
          subtext: 'require immediate action',
          color: (current.severityCounts.critical ?? 0) > 0 ? 'var(--color-sev-critical)' : 'var(--color-ink-faint)',
        };
      case 'high-findings':
        return {
          value: String(current.severityCounts.high ?? 0),
          label: 'high severity',
          subtext: 'findings',
          color: (current.severityCounts.high ?? 0) > 0 ? 'var(--color-sev-high)' : 'var(--color-ink-faint)',
        };
      case 'rules-scanned':
        return {
          value: String(current.totalRules),
          label: 'Rules counted',
          subtext: `${current.passingRules} passing · ${current.unknownRules} unknown`,
          color: 'var(--color-ink)',
        };
      case 'modules-healthy': {
        const counted = perCategory.filter(m => m.total > 0);
        const healthy = counted.filter(m => m.passing === m.total).length;
        return {
          value: `${healthy}/${counted.length}`,
          label: 'categories healthy',
          subtext: 'categories with every counted rule passing',
          color: healthy === counted.length && counted.length > 0 ? 'var(--color-ink)' : 'var(--color-status-warn)',
        };
      }
      case 'new-findings':
        return {
          value: String(current.newInWindow),
          label: `new findings (${windowLabel})`,
          subtext: `first seen ${windowPhrase}`,
          color: current.newInWindow > 0 ? 'var(--color-sev-critical)' : 'var(--color-ink-faint)',
        };
      case 'fixed-findings':
        return {
          value: String(current.fixedInWindow),
          label: `fixed findings (${windowLabel})`,
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

  // A posture with nothing to count says why, in place of "0 of 0".
  if (config.metric === 'posture-pct' && summary && summary.current.pct === null) {
    return <WidgetUnavailable reason={summary.emptyReason ?? postureEmptyReason('filter-left-nothing')} />;
  }

  return (
    <button
      type="button"
      onClick={() => router.push(href)}
      className="flex h-full w-full cursor-pointer flex-col items-start justify-center gap-1 px-5 py-4 text-left transition-colors hover:bg-surface-hover"
      title="View in Scans"
    >
      <span className="numeral-grid text-4xl font-bold leading-none" style={{ color }}>{value}</span>
      <span className="mt-1 text-sm font-medium text-ink-2">{label}</span>
      {config.metric === 'posture-pct' && summary && <PostureDelta summary={summary} />}
      <span className="mt-0.5 text-xs text-ink-muted">{subtext}</span>
    </button>
  );
}
