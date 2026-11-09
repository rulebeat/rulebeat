import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { computeWidgetSummary } from '@/lib/dashboard-data';
import { resolveWidgetRead, respondWithHeldBack } from '@/lib/widget-reads';

export async function GET(req: Request) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const { searchParams } = new URL(req.url);
  const read = await resolveWidgetRead(actor, searchParams);
  if (read instanceof NextResponse) return read;

  // Trend chart period is deliberately a separate param from the delta window. A widget often
  // wants a longer trend chart (e.g. 30d) than the "vs N days ago" delta it also shows (e.g. 7d).
  const trendDaysParam = searchParams.get('trendDays');
  const trendDays = trendDaysParam ? (parseInt(trendDaysParam, 10) || 30) : 30;

  const summary = await computeWidgetSummary(read.filters, trendDays, actor.access);
  return respondWithHeldBack(summary, read.heldBack, read.savedView);
}
