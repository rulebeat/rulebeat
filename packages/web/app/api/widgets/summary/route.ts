import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { computeWidgetSummary } from '@/lib/dashboard-data';
import { readWidgetRequest } from '@/lib/widget-request';

export async function GET(req: Request) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const widget = await readWidgetRequest(req, actor.access);
  if (widget instanceof NextResponse) return widget;

  // The trend chart period is the widget's own stored setting, separate from the delta window: a
  // widget often wants a longer trend chart (e.g. 30d) than the "vs N days ago" delta it also shows.
  const summary = await computeWidgetSummary(widget.filters, widget.trendDays, actor.access);
  return Response.json({ ...summary, ...widget.meta });
}
