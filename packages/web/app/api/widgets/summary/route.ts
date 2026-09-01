import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { computeWidgetSummary } from '@/lib/dashboard-data';
import { parseWidgetFiltersFromSearchParams } from '@/lib/dashboard-filters';

export async function GET(req: Request) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const { searchParams } = new URL(req.url);
  const filters = parseWidgetFiltersFromSearchParams(searchParams);

  // Trend chart period is deliberately a separate param from the delta window — a widget often
  // wants a longer trend chart (e.g. 30d) than the "vs N days ago" delta it also shows (e.g. 7d).
  const trendDaysParam = searchParams.get('trendDays');
  const trendDays = trendDaysParam ? (parseInt(trendDaysParam, 10) || 30) : 30;

  const summary = await computeWidgetSummary(filters, trendDays);
  return Response.json(summary);
}
