/**
 * Which parts of a Shared dashboard a save changed, as field names for the audit log (never their values).
 * `filters` is the dashboard-level filter bar and its date window, `widgets` anything about a widget but where
 * it sits, and `layout` where each widget sits and how big it is. Compared on what is stored, so a save that
 * sends back what is already there changes nothing.
 */
import type { Dashboard, DashboardConfig, WidgetDef } from '@/lib/types';

export const DASHBOARD_EDIT_FIELDS = ['name', 'description', 'filters', 'widgets', 'layout'] as const;
export type DashboardEditField = typeof DASHBOARD_EDIT_FIELDS[number];

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const filtersOf = (config: DashboardConfig) => [config.filters, config.dateWindow, config.windowDays];
const contentOf = (widgets: WidgetDef[]) => widgets.map(({ id, type, title, config }) => ({ id, type, title, config }));
const placementOf = (widgets: WidgetDef[]) => widgets.map(({ id, x, y, w, h }) => ({ id, x, y, w, h }));

export function changedDashboardFields(
  before: Pick<Dashboard, 'name' | 'description' | 'config'>,
  after: Pick<Dashboard, 'name' | 'description' | 'config'>,
): DashboardEditField[] {
  const changed = {
    name: before.name !== after.name,
    description: (before.description ?? '') !== (after.description ?? ''),
    filters: !sameJson(filtersOf(before.config), filtersOf(after.config)),
    widgets: !sameJson(contentOf(before.config.widgets), contentOf(after.config.widgets)),
    layout: !sameJson(placementOf(before.config.widgets), placementOf(after.config.widgets)),
  };
  return DASHBOARD_EDIT_FIELDS.filter(field => changed[field]);
}
