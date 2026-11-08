/**
 * What every counting widget route (summary, findings, top-rules, top-resources, advisories) reads
 * from a request (ADR 0013): the dashboard and widget ids, plus the filter changes from the address.
 * It never takes assembled filter params, and it takes a row limit or trend length from the request
 * only in an edit-mode preview; otherwise those come from the widget's stored config.
 */
import { NextResponse } from 'next/server';
import type { Access } from '@/lib/access-model';
import { effectiveFilters } from '@/lib/effective-filters';
import type { WidgetFilters } from '@/lib/dashboard-filters';
import { DEFAULT_TREND_DAYS, MAX_TREND_DAYS, TREND_CAP_DAYS, storedLimit, storedTrendDays } from '@/lib/widget-settings';

/** The params the routes used to take as an assembled filter. They are refused, not read. */
const ASSEMBLED_FILTER_PARAMS = ['categories', 'subscriptions', 'resourceGroups', 'severities', 'ruleIds', 'policyIds', 'suppressed', 'includeSuppressed'];

/** What a counting response says besides its numbers. */
export interface WidgetResponseMeta {
  /** The revision of the dashboard the numbers were computed from. */
  revision: number;
  /** How many filter values the viewer's access does not reach. Only ever a count. */
  heldBack: number;
}

export interface WidgetRequest {
  filters: WidgetFilters;
  meta: WidgetResponseMeta;
  /** Row limit: the stored config's, or the request's in a preview. Undefined when neither sets one. */
  limit: number | undefined;
  /** Trend length in days, from the stored config (or the request, in a preview). */
  trendDays: number;
}

function positiveInt(value: string | null): number | undefined {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function badRequest(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

function readDraft(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function readWidgetRequest(req: Request, access: Access): Promise<WidgetRequest | NextResponse> {
  const { searchParams } = new URL(req.url);

  if (ASSEMBLED_FILTER_PARAMS.some(name => searchParams.has(name))) {
    return badRequest('Send the dashboard and widget ids with the filter changes, not assembled filters.');
  }
  const dashboardId = searchParams.get('dashboard');
  const widgetId = searchParams.get('widget');
  if (!dashboardId || !widgetId) return badRequest('A dashboard and a widget are required.');

  let preview: { config: Record<string, unknown> } | undefined;
  if (searchParams.get('preview') === '1') {
    const config = readDraft(searchParams.get('draft'));
    if (!config) return badRequest('A preview needs the widget\'s draft config as a JSON object.');
    preview = { config };
  }

  const result = await effectiveFilters({ dashboardId, widgetId, changes: searchParams, access, preview });
  if (!result.ok) {
    return result.reason === 'forbidden'
      ? NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      : NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const requestedLimit = positiveInt(searchParams.get('limit'));
  const requestedTrend = positiveInt(searchParams.get('trendDays'));
  // A widget added in this edit is not stored yet, so a preview names its type itself.
  const type = result.widgetType ?? searchParams.get('type') ?? undefined;
  const cap = (type ? TREND_CAP_DAYS[type] : undefined) ?? MAX_TREND_DAYS;
  const trendDays = preview
    ? Math.min(requestedTrend ?? DEFAULT_TREND_DAYS, cap)
    : storedTrendDays(result.widgetType, result.config);

  return {
    filters: result.filters,
    meta: { revision: result.revision, heldBack: result.heldBack },
    limit: preview ? (requestedLimit ?? storedLimit(result.config)) : storedLimit(result.config),
    trendDays,
  };
}
