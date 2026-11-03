/**
 * Present (`/dashboards/<id>/present`): the questions that have an answer without a browser or a
 * database. The `?refresh=` override, the addresses Exit and the toolbar entry use, the URL filters laid
 * over a dashboard's saved ones, and what Full screen and Esc do. Pure and client-safe, so the page, its
 * client and the tests share one definition.
 */
import { REFRESH_OPTIONS } from '@/components/dashboard/dashboard-constants';
import { parseWidgetFiltersFromSearchParams, type WidgetFilters } from './dashboard-filters';
import type { DateWindow } from './date-window';
import type { DashboardConfig } from './types';

/** How often Present refreshes when the dashboard's own interval is Off. */
export const DEFAULT_PRESENT_REFRESH_SECONDS = 300;

/** The `?refresh=` tokens: the refresh menu's labels, minus Off. */
const REFRESH_SECONDS_BY_TOKEN = new Map(REFRESH_OPTIONS.filter(o => o.value > 0).map(o => [o.label, o.value]));

/** What a page's `searchParams` hold: a value, a repeated value, or nothing. */
export type PresentSearchParams = Record<string, string | string[] | undefined>;

/**
 * The interval Present refreshes at, in seconds: the `?refresh=` token when it is exactly one of the
 * menu's labels, otherwise the dashboard's own interval, otherwise 5 minutes. `off` is not a token: a
 * screen that is meant to refresh always does.
 */
export function presentRefreshSeconds(raw: string | string[] | undefined, dashboardAutoRefresh: number | undefined): number {
  const fromToken = typeof raw === 'string' ? REFRESH_SECONDS_BY_TOKEN.get(raw) : undefined;
  if (fromToken !== undefined) return fromToken;
  return dashboardAutoRefresh && dashboardAutoRefresh > 0 ? dashboardAutoRefresh : DEFAULT_PRESENT_REFRESH_SECONDS;
}

/** The query string both addresses carry: every URL filter, never the `?refresh=` override. */
function filterQuery(search: URLSearchParams): string {
  const kept = new URLSearchParams(search);
  kept.delete('refresh');
  const query = kept.toString();
  return query ? `?${query}` : '';
}

/** Where Exit and Esc lead: the ordinary view, with the URL filters and without `?refresh=`. */
export function exitHref(dashboardId: string, search: URLSearchParams): string {
  return `/dashboards/${dashboardId}${filterQuery(search)}`;
}

/** Where the toolbar's Present action leads: Present, with the current URL filters. */
export function presentHref(dashboardId: string, search: URLSearchParams): string {
  return `/dashboards/${dashboardId}/present${filterQuery(search)}`;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The filters Present reads with: the dashboard's saved filter bar, with each dimension the address names
 * replacing the saved one (a replace, never an intersect, the way a widget's own override works), and a
 * window or range from the address replacing the saved window. A parameter that names nothing usable
 * leaves the saved value alone.
 */
export function presentFilters(config: DashboardConfig, searchParams: PresentSearchParams): WidgetFilters {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    const one = first(value);
    if (one !== undefined) search.set(key, one);
  }
  const fromAddress = parseWidgetFiltersFromSearchParams(search);

  const saved = config.filters ?? {};
  const savedWindow: DateWindow = config.dateWindow ?? { mode: 'relative', days: config.windowDays ?? 7 };
  const namesRange = Boolean(search.get('from') && search.get('to'));
  const windowDays = parseInt(search.get('window') ?? '', 10);
  const namesWindow = Number.isFinite(windowDays) && windowDays > 0;

  const filters: WidgetFilters = {
    categories: fromAddress.categories ?? saved.categories ?? [],
    subscriptions: fromAddress.subscriptions ?? saved.subscriptions ?? [],
    resourceGroups: fromAddress.resourceGroups ?? saved.resourceGroups ?? [],
    tags: fromAddress.tags ?? saved.tags ?? [],
    severities: fromAddress.severities ?? saved.severities ?? [],
    ruleIds: fromAddress.ruleIds ?? saved.ruleIds ?? [],
    dateWindow: namesRange || namesWindow ? fromAddress.dateWindow : savedWindow,
  };
  if (fromAddress.includeSuppressed) filters.includeSuppressed = true;
  return filters;
}

/** The part of `document` the Full screen button reads. */
export interface FullScreenState {
  fullscreenEnabled: boolean;
  fullscreenElement: Element | null;
}

/** Full screen is offered only where the browser allows it and the page is not already in it. */
export function offersFullScreen(doc: FullScreenState): boolean {
  return doc.fullscreenEnabled && doc.fullscreenElement === null;
}

/**
 * What a key press does on Present. Esc leaves Present, except in browser full screen, where the first
 * Esc belongs to the browser and only leaves full screen; a second one leaves Present.
 */
export function escapeAction(
  event: { key: string; defaultPrevented?: boolean },
  doc: Pick<FullScreenState, 'fullscreenElement'>,
): 'exit' | 'none' {
  if (event.key !== 'Escape' || event.defaultPrevented) return 'none';
  return doc.fullscreenElement === null ? 'exit' : 'none';
}
