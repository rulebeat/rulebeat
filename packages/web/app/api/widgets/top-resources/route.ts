import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { queryActiveFindings } from '@/lib/dashboard-data';
import { listCategories } from '@/lib/db/categories';
import { parseWidgetFiltersFromSearchParams } from '@/lib/dashboard-filters';
import { countsInFindingTotals } from '@/lib/finding-kinds';
import type { Severity } from '@/lib/types';

const SEV_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export async function GET(req: Request) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const { searchParams } = new URL(req.url);
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '10'), 50);
  const filters = parseWidgetFiltersFromSearchParams(searchParams);

  // A no-op today: 'activity' findings are already excluded below by the resourceId check.
  const findings = (await queryActiveFindings(filters, actor.access)).filter(countsInFindingTotals);
  const categoryColorById = new Map((await listCategories()).map(c => [c.id, c.color]));

  const resourceMap = new Map<string, { resourceId: string; resourceName: string; resourceType: string; category: string; color?: string; count: number; maxSeverity: Severity }>();
  for (const f of findings) {
    // 'activity' findings (spec 034) have no resource. This widget is resource-scoped by
    // definition, so they're counted by the dedicated activity-occurrences widget instead.
    if (!f.resourceId) continue;
    // Azure ids are not case-sensitive and two rules can write one resource's id in different case:
    // one resource, one row, the same resource the Scans link to it opens.
    const key = f.resourceId.toLowerCase();
    const existing = resourceMap.get(key);
    if (existing) {
      existing.count++;
      if (SEV_ORDER[f.severity] < SEV_ORDER[existing.maxSeverity]) existing.maxSeverity = f.severity;
    } else {
      resourceMap.set(key, {
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
    .slice(0, limit);

  return Response.json(sorted);
}
