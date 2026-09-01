import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { queryActiveFindings } from '@/lib/dashboard-data';
import { loadRules } from '@/lib/rules';
import { listCategories } from '@/lib/db/categories';
import { parseWidgetFiltersFromSearchParams } from '@/lib/dashboard-filters';
import type { Severity } from '@/lib/types';

export async function GET(req: Request) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const { searchParams } = new URL(req.url);
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '10'), 50);
  const filters = parseWidgetFiltersFromSearchParams(searchParams);

  const findings = await queryActiveFindings(filters);
  const ruleById = new Map((await loadRules()).map(r => [r.id, r]));
  const categoryColorById = new Map((await listCategories()).map(c => [c.id, c.color]));

  const ruleMap = new Map<string, { ruleId: string; name: string; count: number; severity: Severity; category: string; color?: string }>();
  for (const f of findings) {
    const existing = ruleMap.get(f.ruleId);
    if (existing) {
      existing.count++;
    } else {
      ruleMap.set(f.ruleId, {
        ruleId: f.ruleId,
        name: ruleById.get(f.ruleId)?.name ?? f.title,
        count: 1,
        severity: f.severity,
        category: f.category,
        color: categoryColorById.get(f.category),
      });
    }
  }

  const sorted = Array.from(ruleMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

  return Response.json(sorted);
}
