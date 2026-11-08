import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { readWidgetRequest } from '@/lib/widget-request';
import { queryAdvisoriesWidget } from '@/lib/advisories-widget-data';
import { ADVISORIES_WIDGET_DEFAULT_LIMIT, ADVISORIES_WIDGET_MAX_LIMIT } from '@/lib/advisories-widget';

export async function GET(req: Request) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const widget = await readWidgetRequest(req, actor.access);
  if (widget instanceof NextResponse) return widget;

  const limit = Math.min(widget.limit ?? ADVISORIES_WIDGET_DEFAULT_LIMIT, ADVISORIES_WIDGET_MAX_LIMIT);
  return Response.json({ ...await queryAdvisoriesWidget(widget.filters, { limit }, actor.access), ...widget.meta });
}
