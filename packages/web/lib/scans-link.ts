import type { WidgetFilters } from './dashboard-filters';
import type { ExplorerStatusFilter } from './explorer-filters';
import { genericFilterParam } from './finding-view';

export { parseCategoryParam } from './finding-view';

/** Metric-appropriate overrides layered on top of a widget's inherited `WidgetFilters` when
 *  building a click-through link to the Scans Results tab: see `buildScansHref`. */
export interface ScansLinkOverrides {
  /** Which tab to open; Results when absent. The Advisories tab reads the same filter params. */
  tab?: 'results' | 'advisories' | 'activity';
  status?: ExplorerStatusFilter;
  /** Single severity to link to (e.g. a "Critical findings" stat card): takes precedence over
   *  any inherited `filters.severities`. */
  severity?: string;
  /** Single category to link to: takes precedence over any inherited `filters.categories`. */
  category?: string;
  /** Single subscription to link to (e.g. a subscription-scorecard card): takes precedence
   *  over any inherited `filters.subscriptions`. */
  subscription?: string;
  /** Single rule id to link to (e.g. a top-rules row): takes precedence over any inherited
   *  `filters.ruleIds`. */
  ruleId?: string;
  /** One resource, by its full id (e.g. a top-resources row): matched exactly, where `search` matches
   *  every resource whose name merely contains the text. */
  resourceId?: string;
  search?: string;
}

/** Builds a `/scans?tab=results&...` href from a dashboard/widget's merged `WidgetFilters` plus
 *  metric-specific overrides, using the exact short param names `scans/page.tsx` parses
 *  (category/status/ruleId/severity/subscription/rg/tags/window-or-from+to/q): shared by every
 *  widget click-through so a new filter dimension only needs to be wired in one place. */
export function buildScansHref(filters: WidgetFilters, overrides: ScansLinkOverrides = {}): string {
  const params = new URLSearchParams();
  params.set('tab', overrides.tab ?? 'results');

  const category = overrides.category ?? (filters.categories?.length ? filters.categories.join(',') : undefined);
  if (category) params.set('category', category);

  if (overrides.status) params.set('status', overrides.status);

  const ruleId = overrides.ruleId ?? (filters.ruleIds?.length ? filters.ruleIds.join(',') : undefined);
  if (ruleId) params.set('ruleId', ruleId);

  const severities = overrides.severity ? [overrides.severity] : filters.severities;
  if (severities?.length) params.set('severity', severities.join(','));

  const subscription = overrides.subscription ?? (filters.subscriptions?.length ? filters.subscriptions.join(',') : undefined);
  if (subscription) params.set('subscription', subscription);
  if (filters.resourceGroups?.length) params.set('rg', filters.resourceGroups.join(','));
  if (filters.tags?.length) params.set('tags', filters.tags.join(','));
  if (filters.dateWindow.mode === 'custom') {
    params.set('from', filters.dateWindow.from);
    params.set('to', filters.dateWindow.to);
  } else {
    params.set('window', String(filters.dateWindow.days));
  }
  if (overrides.resourceId) params.append('f', genericFilterParam('resourceId', [overrides.resourceId]));
  if (overrides.search) params.set('q', overrides.search);

  return `/scans?${params.toString()}`;
}
