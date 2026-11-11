import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { computeWidgetSummary } from '@/lib/dashboard-data';
import { readWidgetRequest } from '@/lib/widget-request';
import { metricScansOverrides, type WidgetSummaryResponse } from '@/lib/widget-links';
import { SEVERITY_ORDER } from '@/lib/severity';

export async function GET(req: Request) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const widget = await readWidgetRequest(req, actor.access);
  if (widget instanceof NextResponse) return widget;

  // The trend chart period is the widget's own stored setting, separate from the delta window: a
  // widget often wants a longer trend chart (e.g. 30d) than the "vs N days ago" delta it also shows.
  const summary = await computeWidgetSummary(widget.filters, widget.trendDays, actor.access);
  const body: WidgetSummaryResponse = {
    ...summary,
    scansHref: widget.numberHref(metricScansOverrides(widget.config['metric'])),
    severityHrefs: Object.fromEntries(SEVERITY_ORDER.map(severity => [severity, widget.numberHref({ severity })])) as WidgetSummaryResponse['severityHrefs'],
    perCategory: summary.perCategory.map(c => ({ ...c, href: widget.href({ category: c.category }) })),
    perSubscription: summary.perSubscription.map(s => ({ ...s, href: widget.href({ subscription: s.subscriptionId }) })),
  };
  return Response.json({ ...body, ...widget.meta });
}
