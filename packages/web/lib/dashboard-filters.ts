import type { Severity } from './types';
import type { DateWindow } from './date-window';

/** Client-safe filter shape shared by every dashboard widget's data request. Dashboard-level
 *  filters (set by a future Phase 4 filter bar) flow down as a prop; each widget merges in its
 *  own per-widget overrides (category/policyIds/window from its config) before calling
 *  /api/widgets/summary. */
export interface WidgetFilters {
  categories?: string[];
  subscriptions?: string[];
  resourceGroups?: string[];
  tags?: string[];
  severities?: Severity[];
  ruleIds?: string[];
  dateWindow: DateWindow;
  includeSuppressed?: boolean;
}

/** Per-widget config values, when present, REPLACE the matching dashboard-level dimension
 *  entirely (never intersect/union) — everything else is inherited unchanged from `dashboard`.
 *  A widget saved with `category: 'all'` (the existing default from widget-config-panel's
 *  Select) means "no override," not "replace with ['all']". An empty array for any list
 *  dimension (subscriptions/resourceGroups/tags/severities) means the same: no override. */
export function mergeWidgetFilters(dashboard: WidgetFilters, widgetCfg: Record<string, unknown>): WidgetFilters {
  const merged: WidgetFilters = { ...dashboard };

  const category = widgetCfg['category'];
  if (typeof category === 'string' && category !== 'all') {
    merged.categories = [category];
  }

  const policyIds = widgetCfg['policyIds'];
  if (Array.isArray(policyIds) && policyIds.length > 0) {
    merged.ruleIds = policyIds as string[];
  }

  const subscriptions = widgetCfg['subscriptions'];
  if (Array.isArray(subscriptions) && subscriptions.length > 0) {
    merged.subscriptions = subscriptions as string[];
  }

  const resourceGroups = widgetCfg['resourceGroups'];
  if (Array.isArray(resourceGroups) && resourceGroups.length > 0) {
    merged.resourceGroups = resourceGroups as string[];
  }

  const tags = widgetCfg['tags'];
  if (Array.isArray(tags) && tags.length > 0) {
    merged.tags = tags as string[];
  }

  const severities = widgetCfg['severities'];
  if (Array.isArray(severities) && severities.length > 0) {
    merged.severities = severities as Severity[];
  }

  // Per-widget window override stays relative-only (24h/7d/30d/inherit) — a secondary,
  // rarely-used power override; full custom-range picking lives on the dashboard filter bar.
  const windowDays = widgetCfg['windowDays'];
  if (windowDays === 1 || windowDays === 7 || windowDays === 30) {
    merged.dateWindow = { mode: 'relative', days: windowDays };
  }

  return merged;
}

/** True when a widget's saved config carries any Scope override (category/rules/subscription/
 *  RG/tags/severity/window) — used alongside the dashboard-level `hasActiveFilters` to decide
 *  whether the "scoped" funnel indicator shows on the widget title, so a widget-level override
 *  is just as visible as a dashboard-level filter. Mirrors mergeWidgetFilters' own semantics
 *  (`category: 'all'` and empty arrays mean "inherit", not "override"). */
export function widgetHasScopeOverrides(cfg: Record<string, unknown>): boolean {
  if (typeof cfg['category'] === 'string' && cfg['category'] !== 'all') return true;
  for (const key of ['policyIds', 'subscriptions', 'resourceGroups', 'tags', 'severities'] as const) {
    const v = cfg[key];
    if (Array.isArray(v) && v.length > 0) return true;
  }
  const windowDays = cfg['windowDays'];
  return windowDays === 1 || windowDays === 7 || windowDays === 30;
}

/** Parses the same query-string shape `buildSummaryParams` produces back into a `WidgetFilters`
 *  — the server-side counterpart, shared by every widget API route so a new filter dimension
 *  only needs to be wired in one place. `ruleIds`/`policyIds` both accepted for back-compat. */
export function parseWidgetFiltersFromSearchParams(searchParams: URLSearchParams): WidgetFilters {
  function parseList(param: string | null): string[] | undefined {
    if (!param) return undefined;
    const list = param.split(',').map(s => s.trim()).filter(Boolean);
    return list.length > 0 ? list : undefined;
  }

  const fromParam = searchParams.get('from');
  const toParam = searchParams.get('to');
  let dateWindow: DateWindow;
  if (fromParam && toParam) {
    dateWindow = { mode: 'custom', from: fromParam, to: toParam };
  } else {
    const windowParam = parseInt(searchParams.get('window') ?? '7', 10);
    dateWindow = { mode: 'relative', days: Number.isFinite(windowParam) && windowParam > 0 ? windowParam : 7 };
  }

  return {
    categories: parseList(searchParams.get('categories')),
    subscriptions: parseList(searchParams.get('subscriptions')),
    resourceGroups: parseList(searchParams.get('resourceGroups')),
    tags: parseList(searchParams.get('tags')),
    severities: parseList(searchParams.get('severities')) as Severity[] | undefined,
    ruleIds: parseList(searchParams.get('ruleIds')) ?? parseList(searchParams.get('policyIds')),
    dateWindow,
    includeSuppressed: searchParams.get('suppressed') === '1',
  };
}

/** Builds the URLSearchParams for a /api/widgets/summary request from a merged WidgetFilters —
 *  shared by every widget that reads live posture/finding numbers, so a new filter dimension
 *  only needs to be wired in one place. Does not set `trendDays` — callers that need a trend
 *  chart period distinct from the delta window (e.g. TrendWidget) add that param themselves. */
export function buildSummaryParams(filters: WidgetFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.categories?.length) params.set('categories', filters.categories.join(','));
  if (filters.subscriptions?.length) params.set('subscriptions', filters.subscriptions.join(','));
  if (filters.resourceGroups?.length) params.set('resourceGroups', filters.resourceGroups.join(','));
  if (filters.tags?.length) params.set('tags', filters.tags.join(','));
  if (filters.severities?.length) params.set('severities', filters.severities.join(','));
  if (filters.ruleIds?.length) params.set('ruleIds', filters.ruleIds.join(','));
  if (filters.includeSuppressed) params.set('suppressed', '1');
  if (filters.dateWindow.mode === 'custom') {
    params.set('from', filters.dateWindow.from);
    params.set('to', filters.dateWindow.to);
  } else {
    params.set('window', String(filters.dateWindow.days));
  }
  return params;
}
