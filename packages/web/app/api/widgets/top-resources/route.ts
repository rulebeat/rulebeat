import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { queryActiveFindings } from '@/lib/dashboard-data';
import { listCategories } from '@/lib/db/categories';
import { readWidgetRequest } from '@/lib/widget-request';
import { countsInFindingTotals } from '@/lib/finding-kinds';
import { findingSubject } from '@/lib/finding-view';
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

  type Row = { resourceId: string; resourceName: string; resourceType: string; category: string; color?: string; href: string; count: number; maxSeverity: Severity };
  const resourceMap = new Map<string, Row>();
  const spellings = new Map<string, { resourceName: Set<string>; resourceType: Set<string>; resourceGroup: Set<string> }>();
  for (const f of findings) {
    // 'activity' findings (spec 034) have no resource. This widget is resource-scoped by
    // definition, so they're counted by the dedicated activity-occurrences widget instead.
    if (!f.resourceId) continue;
    const seen = spellings.get(f.resourceId) ?? { resourceName: new Set<string>(), resourceType: new Set<string>(), resourceGroup: new Set<string>() };
    spellings.set(f.resourceId, seen);
    seen.resourceName.add(findingSubject(f));
    if (f.resourceType) seen.resourceType.add(f.resourceType);
    if (f.resourceGroup) seen.resourceGroup.add(f.resourceGroup);
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
        href: '',
        count: 1,
        maxSeverity: f.severity,
      });
    }
  }

  const sorted = Array.from(resourceMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
  // The link names every spelling the row's findings were stored with, so it opens all of them.
  for (const row of sorted) {
    const first = findings.find(f => f.resourceId === row.resourceId)!;
    const seen = spellings.get(row.resourceId)!;
    row.href = widget.resourceHref({
      ...first,
      alsoStoredAs: { resourceName: [...seen.resourceName], resourceType: [...seen.resourceType], resourceGroup: [...seen.resourceGroup] },
    });
  }

  return Response.json({ items: sorted, ...widget.meta });
}
