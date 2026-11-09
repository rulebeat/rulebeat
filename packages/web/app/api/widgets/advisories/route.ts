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
  const data = await queryAdvisoriesWidget(widget.filters, { limit }, actor.access);
  const items = data.items.map(({ resourceType, subscriptionId, resourceGroup, placement, ...item }) => ({
    ...item,
    href: widget.resourceHref({ ...item, resourceType, subscriptionId, resourceGroup, placement }, { tab: 'advisories', ruleId: item.ruleId }),
  }));
  return Response.json({ ...data, items, ...widget.meta });
}
