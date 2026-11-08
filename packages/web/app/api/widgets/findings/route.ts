import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { queryActiveFindings } from '@/lib/dashboard-data';
import { readWidgetRequest } from '@/lib/widget-request';
import { countsInFindingTotals } from '@/lib/finding-kinds';

export async function GET(req: Request) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const widget = await readWidgetRequest(req, actor.access);
  if (widget instanceof NextResponse) return widget;
  const limit = Math.min(widget.limit ?? 20, 200);

  const all = (await queryActiveFindings(widget.filters, actor.access)).filter(countsInFindingTotals);
  // Recent findings feed: newest-first by when each finding first appeared.
  all.sort((a, b) => new Date(b.firstSeenAt).getTime() - new Date(a.firstSeenAt).getTime());

  const items = all.slice(0, limit).map(f => ({ ...f, href: widget.href({ ruleId: f.ruleId, search: f.resourceName }) }));
  return Response.json({ items, ...widget.meta });
}
