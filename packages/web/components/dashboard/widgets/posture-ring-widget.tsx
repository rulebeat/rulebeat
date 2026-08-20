'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import type { WidgetSummary } from '@/lib/dashboard-data';
import { mergeWidgetFilters, buildSummaryParams, type WidgetFilters } from '@/lib/dashboard-filters';
import { buildScansHref } from '@/lib/scans-link';
import { CATEGORY_LABELS, postureColor } from '@/components/dashboard/dashboard-constants';
import { Delta } from '@/components/dashboard/widgets/delta';
import { useWidgetFetch } from '@/lib/hooks/use-widget-fetch';
import { WidgetUnavailable } from '@/components/dashboard/widgets/widget-unavailable';

interface Config { category?: string; showDelta?: boolean; showPolicyCounts?: boolean; policyIds?: string[] }
interface Props { config: Config; filters: WidgetFilters; refreshKey: number }

function Ring({ pct, label, size = 120 }: { pct: number; label: string; size?: number }) {
  const R = size * 0.44;
  const C = 2 * Math.PI * R;
  const offset = C * (1 - pct / 100);
  const color = postureColor(pct);
  const sw = size * 0.08;
  return (
    <div className="relative flex items-center justify-center shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={R} fill="none" stroke="var(--color-track)" strokeWidth={sw} />
        <circle
          cx={size / 2} cy={size / 2} r={R} fill="none"
          stroke={color} strokeWidth={sw} strokeLinecap="butt"
          strokeDasharray={C} strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 0.8s ease' }}
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="numeral-grid font-semibold leading-none" style={{ color, fontSize: size * 0.16 }}>{label}</span>
      </div>
    </div>
  );
}

export function PostureRingWidget({ config, filters, refreshKey }: Props) {
  const router = useRouter();
  const merged = useMemo(() => mergeWidgetFilters(filters, config as unknown as Record<string, unknown>), [filters, config]);
  const params = buildSummaryParams(merged).toString();
  const { data: summary, loading, failed, retry } = useWidgetFetch<WidgetSummary>(
    `/api/widgets/summary?${params}`,
    [refreshKey]
  );

  // `summary.current` is a WidgetSummary field named "current" (the live-vs-baseline pair), not a
  // React ref; the compiler's ref-access heuristic misreads it. `summary` is already in the deps
  // below, a safe superset of every summary.current.* path it flags.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const result = useMemo(() => {
    if (!summary || summary.current.pct === null) return null;
    const ruleIds = merged.ruleIds ?? [];
    const categories = merged.categories ?? [];
    // Prefer the live DB label from perCategory (categories are user-extensible rows) — the
    // hardcoded constant is only a fallback for categories with no scan data in the summary.
    const liveLabel = new Map(summary.perCategory.map(m => [m.category, m.label]));
    const label = ruleIds.length > 0
      ? `${ruleIds.length} selected rule${ruleIds.length === 1 ? '' : 's'}`
      : categories.length === 1
        ? (liveLabel.get(categories[0]) ?? CATEGORY_LABELS[categories[0]] ?? categories[0])
        : 'All Categories';
    return {
      pct: summary.current.pct,
      delta: summary.deltaPct,
      baselineDate: summary.baseline?.date ?? null,
      totalPolicies: summary.current.totalRules,
      passing: summary.current.passingRules,
      unknown: summary.current.unknownRules,
      label,
    };
  }, [summary, merged.ruleIds, merged.categories]);

  const href = buildScansHref(merged);

  if (loading) return <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-ink-muted" /></div>;

  if (failed) return <WidgetUnavailable onRetry={retry} />;

  if (!result) {
    return (
      <button
        type="button"
        onClick={() => router.push(href)}
        className="flex h-full w-full cursor-pointer flex-col items-center justify-center gap-2 transition-colors hover:bg-surface-hover"
      >
        <Ring pct={0} label="0/0" />
        <p className="text-sm text-ink-muted">No scan data</p>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => router.push(href)}
      title="View in Scans"
      className="flex h-full w-full cursor-pointer flex-col items-center justify-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-hover"
    >
      <Ring pct={result.pct} label={`${result.passing}/${result.totalPolicies}`} />
      <div className="space-y-1 text-center">
        <p className="text-sm font-semibold text-ink">{result.label}</p>
        {config.showDelta && result.delta !== null && (
          <Delta
            value={result.delta}
            suffix="% vs baseline"
            title={result.baselineDate ? `score today vs baseline since ${result.baselineDate}` : undefined}
            size="xs"
            display="inline-flex"
          />
        )}
        <p className="text-xs text-ink-2">checks passing</p>
        {result.unknown > 0 && (
          <p className="text-xs text-ink-muted">{result.unknown} not yet proven</p>
        )}
      </div>
    </button>
  );
}
