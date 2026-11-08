import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { queryActiveFindings } from '@/lib/dashboard-data';
import { listCategories } from '@/lib/db/categories';
import { readWidgetRequest } from '@/lib/widget-request';
import { countsInFindingTotals } from '@/lib/finding-kinds';
import type { Severity } from '@/lib/types';

const SEV_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export async function GET(req: Request) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const widget = await readWidgetRequest(req, actor.access);
  if (widget instanceof NextResponse) return widget;
  const limit = Math.min(widget.limit ?? 10, 50);

  // A no-op today: 'activity' findings are already excluded below by the resourceId check.
  const findings = (await queryActiveFindings(widget.filters, actor.access)).filter(countsInFindingTotals);
  const categoryColorById = new Map((await listCategories()).map(c => [c.id, c.color]));

  const resourceMap = new Map<string, { resourceId: string; resourceName: string; resourceType: string; category: string; color?: string; count: number; maxSeverity: Severity }>();
  for (const f of findings) {
    // 'activity' findings (spec 034) have no resource. This widget is resource-scoped by
    // definition, so they're counted by the dedicated activity-occurrences widget instead.
    if (!f.resourceId) continue;
    const existing = resourceMap.get(f.resourceId);
    if (existing) {
      existing.count++;
      if (SEV_ORDER[f.severity] < SEV_ORDER[existing.maxSeverity]) existing.maxSeverity = f.severity;
    } else {
      resourceMap.set(f.resourceId, {
        resourceId: f.resourceId,
        resourceName: f.resourceName ?? '',
        resourceType: f.resourceType ?? '',
        category: f.category,
        color: categoryColorById.get(f.category),
        count: 1,
        maxSeverity: f.severity,
      });
    }
  }

  const sorted = Array.from(resourceMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map(resource => ({ ...resource, href: widget.href({ search: resource.resourceName }) }));

  return Response.json({ items: sorted, ...widget.meta });
}
