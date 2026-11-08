import type { DashboardConfig, Severity } from './types';
import type { DashboardFilterChanges, DashboardFilters } from './finding-view';
import type { DateWindow } from './date-window';

/** Client-safe filter shape shared by every dashboard widget's data request. Dashboard-level
 *  filters flow down as a prop for display and links; each widget merges in its own per-widget
 *  overrides (category/policyIds/window from its config). The widget routes assemble the same
 *  layers themselves (`lib/effective-filters.ts`) from ids and filter changes, never from this. */
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
 *  entirely (never intersect/union): everything else is inherited unchanged from `dashboard`.
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

  // Per-widget window override stays relative-only (24h/7d/30d/inherit). A secondary,
  // rarely-used power override; full custom-range picking lives on the dashboard filter bar.
  const windowDays = widgetCfg['windowDays'];
  if (windowDays === 1 || windowDays === 7 || windowDays === 30) {
    merged.dateWindow = { mode: 'relative', days: windowDays };
  }

  return merged;
}

/** True when a widget's saved config carries any Scope override (category/rules/subscription/
 *  RG/tags/severity/window): used alongside the dashboard-level `hasActiveFilters` to decide
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

/** The filters a dashboard saved, in the shape the address changes are differences from. The
 *  window falls back to the legacy `windowDays`, then to 7 days, the way the dashboard page does. */
export function savedFiltersOf(config: DashboardConfig): DashboardFilters {
  return {
    category: config.filters?.categories ?? [],
    subscription: config.filters?.subscriptions ?? [],
    resourceGroup: config.filters?.resourceGroups ?? [],
    tags: config.filters?.tags ?? [],
    rule: config.filters?.ruleIds ?? [],
    severity: config.filters?.severities ?? [],
    window: config.dateWindow ?? { mode: 'relative', days: config.windowDays ?? 7 },
  };
}

/** The saved filters with each dimension a change sets replacing the saved one. */
export function applyChanges(saved: DashboardFilters, changes: DashboardFilterChanges): DashboardFilters {
  return { ...saved, ...changes };
}

/** `WidgetFilters` is what the counting code reads. Empty lists are written as absent, as the widgets always did. */
export function widgetFiltersOf(filters: DashboardFilters): WidgetFilters {
  const list = (values: string[]) => (values.length > 0 ? values : undefined);
  return {
    categories: list(filters.category),
    subscriptions: list(filters.subscription),
    resourceGroups: list(filters.resourceGroup),
    tags: list(filters.tags),
    severities: list(filters.severity) as Severity[] | undefined,
    ruleIds: list(filters.rule),
    dateWindow: filters.window,
  };
}

/** The filter bar's state as a dashboard's dimensions. */
export function dashboardFiltersOf(bar: {
  categories: string[]; subscriptions: string[]; resourceGroups: string[]; tags: string[]; severities: string[]; ruleIds: string[];
}, window: DateWindow): DashboardFilters {
  return {
    category: bar.categories, subscription: bar.subscriptions, resourceGroup: bar.resourceGroups,
    tags: bar.tags, rule: bar.ruleIds, severity: bar.severities, window,
  };
}

export function sameValues(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every(v => right.has(v));
}

/** Only the dimensions of `current` that are not what `saved` holds, as filter changes. */
export function differencesFromSaved(saved: DashboardFilters, current: DashboardFilters): DashboardFilterChanges {
  const changes: DashboardFilterChanges = {};
  for (const dim of ['category', 'subscription', 'resourceGroup', 'tags', 'rule', 'severity'] as const) {
    if (!sameValues(current[dim], saved[dim])) changes[dim] = current[dim];
  }
  if (JSON.stringify(current.window) !== JSON.stringify(saved.window)) changes.window = current.window;
  return changes;
}

/** How many of `configs` (widget configs) set their own value for each dimension, by the same rule
 *  `mergeWidgetFilters` replaces the dashboard's: `category: 'all'` and an empty list inherit. */
export function overriddenDimensions(configs: readonly Record<string, unknown>[]): Record<keyof DashboardFilters, number> {
  const counts: Record<keyof DashboardFilters, number> = { category: 0, subscription: 0, resourceGroup: 0, tags: 0, rule: 0, severity: 0, window: 0 };
  const listed = (cfg: Record<string, unknown>, key: string) => Array.isArray(cfg[key]) && (cfg[key] as unknown[]).length > 0;
  for (const cfg of configs) {
    if (typeof cfg['category'] === 'string' && cfg['category'] !== 'all') counts.category++;
    if (listed(cfg, 'subscriptions')) counts.subscription++;
    if (listed(cfg, 'resourceGroups')) counts.resourceGroup++;
    if (listed(cfg, 'tags')) counts.tags++;
    if (listed(cfg, 'policyIds')) counts.rule++;
    if (listed(cfg, 'severities')) counts.severity++;
    if (cfg['windowDays'] === 1 || cfg['windowDays'] === 7 || cfg['windowDays'] === 30) counts.window++;
  }
  return counts;
}

/** `incoming` with the stored dashboard's saved filters, window and legacy window kept as stored. A
 *  layout save is not how those change, whatever the request carries. */
export function keepSavedFilters(stored: DashboardConfig, incoming: DashboardConfig): DashboardConfig {
  const { filters: _filters, dateWindow: _dateWindow, windowDays: _windowDays, ...layout } = incoming;
  return {
    ...layout,
    ...(stored.filters !== undefined && { filters: stored.filters }),
    ...(stored.dateWindow !== undefined && { dateWindow: stored.dateWindow }),
    ...(stored.windowDays !== undefined && { windowDays: stored.windowDays }),
  };
}
