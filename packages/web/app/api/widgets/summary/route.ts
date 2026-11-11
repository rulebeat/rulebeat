import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { computeWidgetSummary } from '@/lib/dashboard-data';
import { parseWidgetFiltersFromSearchParams } from '@/lib/dashboard-filters';

export async function GET(req: Request) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const { searchParams } = new URL(req.url);
  const filters = parseWidgetFiltersFromSearchParams(searchParams);
  const summary = await computeWidgetSummary(filters, actor.access);
  return Response.json(summary);
}
