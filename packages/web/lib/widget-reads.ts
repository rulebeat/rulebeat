/**
 * The server half of a widget read (#375, ADR 0012): what filter a widget's request means for the person
 * who sent it. The request names a dashboard and a widget and carries the values the person can see for each
 * place. The values each place stores that the person's Access does not reach are added back here, then
 * `mergeWidgetFilters()`' replace rule runs unchanged, so a widget's own value replaces the dashboard's,
 * held-back values included.
 *
 * A held-back value matches nothing for the reader. A dimension that holds only held-back values is read as
 * the placeholder `OUTSIDE_ACCESS_LABEL`, which no finding carries, so it never widens to the whole of the
 * person's Access.
 */
import { NextResponse } from 'next/server';
import { getDashboard } from './db/dashboards';
import { heldBackForRead, type PlaceHeldBack } from './db/held-back';
import { mergeWidgetFilters, parseWidgetReadFromSearchParams, type WidgetFilters } from './dashboard-filters';
import { OUTSIDE_ACCESS_LABEL, type HeldBack } from './held-back';
import { guardItem, itemNotFound, type ItemActor } from './item-access';
import type { Dashboard } from './types';

export interface WidgetRead {
  filters: WidgetFilters;
  heldBack: HeldBack[];
}

const SCOPE_DIMENSIONS = [['subscriptions', 'subscription'], ['resourceGroups', 'resourceGroup']] as const;

const withoutPlaceholder = (values: readonly string[] | undefined) => (values ?? []).filter(value => value !== OUTSIDE_ACCESS_LABEL);
const union = (...lists: readonly (readonly string[])[]) => [...new Set(lists.flat())];

/** The dashboard a read names, or the one answer for an unknown id and for someone else's Personal dashboard. */
async function openDashboard(actor: ItemActor, id: string): Promise<Dashboard | NextResponse> {
  const dashboard = await getDashboard(id);
  return guardItem(actor, 'dashboard', dashboard, 'open') ?? dashboard ?? itemNotFound();
}

/**
 * For the reads that apply no filter (the rule list, the filter options): null, or the 404 for a dashboard id
 * the person cannot open. A request that names none is let through.
 */
export async function guardWidgetDashboard(actor: ItemActor, searchParams: URLSearchParams): Promise<NextResponse | null> {
  const id = searchParams.get('dashboardId');
  if (!id) return null;
  const dashboard = await openDashboard(actor, id);
  return dashboard instanceof NextResponse ? dashboard : null;
}

/**
 * Resolves a widget read, or the response to return: a 404 for an unknown dashboard id and for someone else's
 * Personal dashboard. A request that names no dashboard (a widget drawn outside one) is the merged filters it
 * carried, with nothing held back.
 */
export async function resolveWidgetRead(actor: ItemActor, searchParams: URLSearchParams): Promise<WidgetRead | NextResponse> {
  const request = parseWidgetReadFromSearchParams(searchParams);
  if (request.dashboardId === null) return { filters: mergeWidgetFilters(request.dashboard, request.widget), heldBack: [] };

  const dashboard = await openDashboard(actor, request.dashboardId);
  if (dashboard instanceof NextResponse) return dashboard;

  const place = await heldBackForRead(actor.access, dashboard, request.widgetId);
  const page: WidgetFilters = { ...request.dashboard };
  const own: Record<string, unknown> = { ...request.widget };
  for (const [key, dimension] of SCOPE_DIMENSIONS) {
    const onPage = union(withoutPlaceholder(page[key]), place.dashboard.get(dimension) ?? []);
    page[key] = onPage.length > 0 ? onPage : undefined;
    const onWidget = union(withoutPlaceholder(own[key] as string[] | undefined), place.widget.get(dimension) ?? []);
    if (onWidget.length > 0) own[key] = onWidget;
    else delete own[key];
  }
  return { filters: matchNothingHeld(mergeWidgetFilters(page, own), place), heldBack: place.counts };
}

/** The merged filters with every held-back value out of them. A dimension left with nothing but those holds the placeholder. */
function matchNothingHeld(merged: WidgetFilters, place: PlaceHeldBack): WidgetFilters {
  const filters = { ...merged };
  for (const [key, dimension] of SCOPE_DIMENSIONS) {
    const values = filters[key];
    if (!values?.length) continue;
    const visible = values.filter(value => !place.held.get(dimension)?.has(value));
    filters[key] = visible.length > 0 ? visible : [OUTSIDE_ACCESS_LABEL];
  }
  return filters;
}

/**
 * A JSON answer that reports what is held back: in the object as `heldBack`, or in an `X-Held-Back` header when the
 * answer is a list. Nothing is added when nothing is held back, so an answer keeps its shape for everyone else.
 */
export function respondWithHeldBack(body: unknown, heldBack: readonly HeldBack[]): Response {
  if (heldBack.length === 0) return Response.json(body);
  if (Array.isArray(body)) return Response.json(body, { headers: { 'X-Held-Back': JSON.stringify(heldBack) } });
  return Response.json({ ...(body as object), heldBack });
}
