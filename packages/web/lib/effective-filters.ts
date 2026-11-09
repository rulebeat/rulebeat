/**
 * The effective filters of one dashboard widget (ADR 0013), assembled on the server so the layers
 * cannot drift between the bar and the widgets: the filters saved on the dashboard, then the filter
 * changes from the address, then the widget's own override. Each layer replaces the one before for a
 * dimension it sets and never intersects with it. `effectiveView` does the same for a saved view open
 * on /scans, which has the first two layers.
 *
 * A value the viewer's access does not reach stays in the filter, so it keeps restricting and the
 * numbers stay the ones the access allows (the reads narrow by access in SQL). It is reported as a
 * count and never named.
 */
import { getDashboard } from '@/lib/db/dashboards';
import { getSavedView } from '@/lib/db/saved-views';
import { dashboardAddress, savedViewAddress, viewFromSearchParams, type View } from '@/lib/finding-view';
import type { OpenSavedView } from '@/lib/saved-view-query';
import {
  applyChanges, mergeWidgetFilters, savedFiltersOf, widgetFiltersOf, type WidgetFilters,
} from '@/lib/dashboard-filters';
import { markOutsideAccess } from '@/lib/outside-access';
import { mayAct } from '@/lib/rbac';
import type { Access } from '@/lib/access-model';

export interface EffectiveFiltersInput {
  dashboardId: string;
  /** The widget on the dashboard. A preview may name one that is not saved yet. */
  widgetId: string;
  /** The address the widget was asked from. Only the dashboard's filter params are read. */
  changes: URLSearchParams;
  access: Access;
  /** Edit-mode preview: the widget's draft config, in place of the stored one. Needs the edit right. */
  preview?: { config: Record<string, unknown> };
}

export type EffectiveFilters =
  | {
    ok: true;
    /** The revision of the dashboard row these filters were computed from. */
    revision: number;
    filters: WidgetFilters;
    /** How many subscription and resource group values the viewer's access does not reach. */
    heldBack: number;
    widgetType: string | undefined;
    /** The widget's config: the stored one, or the draft in a preview. */
    config: Record<string, unknown>;
  }
  | { ok: false; reason: 'not-found' | 'forbidden' };

function asList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** `draft` with the values of `stored` that `access` does not reach added back, so a draft written by
 *  someone who could not see them cannot drop them. */
function withHeldBackValues(access: Access, stored: Record<string, unknown>, draft: Record<string, unknown>): Record<string, unknown> {
  const held = markOutsideAccess(access, { subscriptions: asList(stored['subscriptions']), resourceGroups: asList(stored['resourceGroups']) });
  const merged = { ...draft };
  for (const [key, values] of [['subscriptions', held.subscriptions], ['resourceGroups', held.resourceGroups]] as const) {
    if (values.length === 0) continue;
    const have = new Set(asList(draft[key]).map(v => v.toLowerCase()));
    merged[key] = [...asList(draft[key]), ...values.filter(v => !have.has(v.toLowerCase()))];
  }
  return merged;
}

export async function effectiveFilters(input: EffectiveFiltersInput): Promise<EffectiveFilters> {
  if (input.preview && !mayAct(input.access, 'dashboards:write')) return { ok: false, reason: 'forbidden' };

  const dashboard = await getDashboard(input.dashboardId);
  if (!dashboard) return { ok: false, reason: 'not-found' };
  const stored = dashboard.config.widgets.find(w => w.id === input.widgetId);
  if (!stored && !input.preview) return { ok: false, reason: 'not-found' };

  const storedConfig = (stored?.config ?? {}) as Record<string, unknown>;
  const config = input.preview ? withHeldBackValues(input.access, storedConfig, input.preview.config) : storedConfig;

  const saved = savedFiltersOf(dashboard.config);
  const layered = applyChanges(saved, dashboardAddress(saved).read(input.changes));
  const filters = mergeWidgetFilters(widgetFiltersOf(layered), config);

  const held = markOutsideAccess(input.access, filters);
  return {
    ok: true,
    revision: dashboard.revision,
    filters,
    heldBack: held.subscriptions.length + held.resourceGroups.length,
    widgetType: stored?.type,
    config,
  };
}

export type EffectiveView =
  | {
    ok: true;
    /** The saved view with the address's changes on top: what the person is looking at. */
    view: View;
    /** The saved view the address has open, as it is now. */
    saved: OpenSavedView;
  }
  | { ok: false; reason: 'unavailable' };

/**
 * The effective View of an address that has a saved view open (ADR 0013): the view's saved query, then
 * the changes the address holds, each replacing the saved part it names (`savedViewAddress`). The
 * client sends the view's id and the changes, never a copy of the query, so a link follows the view's
 * later updates. A view that is unknown, deleted, or not the person's to open is one answer,
 * `unavailable`, so the three cannot be told apart. The viewer's access narrows what the View reads in
 * SQL, as it does for any View, so a saved value outside it keeps restricting and is never named.
 */
export async function effectiveView(input: { viewId: string; changes: URLSearchParams | Record<string, string | string[] | undefined> }): Promise<EffectiveView> {
  const stored = await getSavedView(input.viewId);
  if (!stored) return { ok: false, reason: 'unavailable' };
  // The page is where a viewer happens to be, so a saved query written before it was dropped does not carry one.
  const view = { ...viewFromSearchParams(new URLSearchParams(stored.query)), page: 1 };
  return {
    ok: true,
    view: savedViewAddress(view).read(input.changes),
    saved: { id: stored.id, revision: stored.revision, view },
  };
}
