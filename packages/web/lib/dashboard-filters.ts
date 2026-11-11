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

/** The dimensions a widget's own config overrides, named as the dashboard's filter bar names them. Same
 *  semantics as `mergeWidgetFilters`: `category: 'all'` and an empty list inherit instead of overriding. */
export function widgetOverriddenDimensions(cfg: Record<string, unknown>): string[] {
  const dimensions: string[] = [];
  if (typeof cfg['category'] === 'string' && cfg['category'] !== 'all') dimensions.push('Category');
  const lists: Array<[string, string]> = [
    ['policyIds', 'Rule'], ['subscriptions', 'Subscription'], ['resourceGroups', 'Resource Group'], ['tags', 'Tags'], ['severities', 'Severity'],
  ];
  for (const [key, label] of lists) {
    const v = cfg[key];
    if (Array.isArray(v) && v.length > 0) dimensions.push(label);
  }
  const windowDays = cfg['windowDays'];
  if (windowDays === 1 || windowDays === 7 || windowDays === 30) dimensions.push('Window');
  return dimensions;
}

/** True when a widget's saved config carries any Scope override (category/rules/subscription/
 *  RG/tags/severity/window): used alongside the dashboard-level `hasActiveFilters` to decide
 *  whether the "scoped" funnel indicator shows on the widget title, so a widget-level override
 *  is just as visible as a dashboard-level filter. */
export function widgetHasScopeOverrides(cfg: Record<string, unknown>): boolean {
  return widgetOverriddenDimensions(cfg).length > 0;
}

/** What the funnel on a widget title says: which dimensions the widget sets itself, so a change in the
 *  filter bar does not reach them, and whether the dashboard's filters apply to the rest. */
export function widgetScopeNote(cfg: Record<string, unknown>, dashboardFiltered: boolean): string {
  const own = widgetOverriddenDimensions(cfg);
  if (own.length === 0) return 'Scoped by the dashboard\'s filters.';
  const named = own.length === 1 ? own[0]! : `${own.slice(0, -1).join(', ')} and ${own[own.length - 1]}`;
  return `This widget uses its own ${named}.${dashboardFiltered ? ' The dashboard\'s filters apply to the rest.' : ''}`;
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

function sameValues(a: readonly string[], b: readonly string[]): boolean {
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
