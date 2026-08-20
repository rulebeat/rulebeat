import type { DashboardConfig, WidgetDef } from './types';

// Pure data transform only — no lib/db/* imports (mirrors dashboard-templates.ts) so it can run
// from rowToDashboard() on every read without a server/client boundary concern.

const WIDGET_TYPE_MAP: Record<string, WidgetDef['type']> = {
  'findings-table': 'recent-findings',
  'findings-explorer': 'recent-findings',
  'top-policies': 'top-rules',
};

const STAT_METRIC_MAP: Record<string, string> = {
  'open-findings': 'total-findings',
  'new-findings-7d': 'new-findings',
  'fixed-findings-7d': 'fixed-findings',
  'policies-scanned': 'rules-scanned',
};

/** Applied on every dashboard read (see `rowToDashboard` in `lib/db/dashboards.ts`) so old
 *  widget types / stat-metric ids saved before the dashboard refinement pass keep rendering
 *  correctly, with zero explicit user-facing migration step. Idempotent — a config with nothing
 *  to migrate passes through unchanged. */
export function migrateDashboardConfig(config: DashboardConfig): DashboardConfig {
  let changed = false;
  const widgets = config.widgets.map((w): WidgetDef => {
    const mappedType = WIDGET_TYPE_MAP[w.type as string];
    const mappedMetric = typeof w.config.metric === 'string' ? STAT_METRIC_MAP[w.config.metric] : undefined;
    if (!mappedType && !mappedMetric) return w;
    changed = true;
    return {
      ...w,
      type: mappedType ?? w.type,
      config: mappedType === 'recent-findings'
        ? { limit: w.config.limit, category: w.config.category, policyIds: w.config.policyIds }
        : mappedMetric ? { ...w.config, metric: mappedMetric } : w.config,
    };
  });
  return changed ? { ...config, widgets } : config;
}
