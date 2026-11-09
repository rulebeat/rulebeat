import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { resolveWidgetRead, respondWithHeldBack } from '@/lib/widget-reads';
import { queryAdvisoriesWidget } from '@/lib/advisories-widget-data';
import { ADVISORIES_WIDGET_DEFAULT_LIMIT, ADVISORIES_WIDGET_MAX_LIMIT } from '@/lib/advisories-widget';

export async function GET(req: Request) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const { searchParams } = new URL(req.url);
  const requested = parseInt(searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, ADVISORIES_WIDGET_MAX_LIMIT)
    : ADVISORIES_WIDGET_DEFAULT_LIMIT;
  const read = await resolveWidgetRead(actor, searchParams);
  if (read instanceof NextResponse) return read;

  return respondWithHeldBack(await queryAdvisoriesWidget(read.filters, { limit }, actor.access), read.heldBack);
}
