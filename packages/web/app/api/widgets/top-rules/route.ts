import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { queryActiveFindings } from '@/lib/dashboard-data';
import { loadRules } from '@/lib/rules';
import { listCategories } from '@/lib/db/categories';
import { readWidgetRequest } from '@/lib/widget-request';
import { countsInFindingTotals } from '@/lib/finding-kinds';
import type { Severity } from '@/lib/types';

export async function GET(req: Request) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const widget = await readWidgetRequest(req, actor.access);
  if (widget instanceof NextResponse) return widget;
  const limit = Math.min(widget.limit ?? 10, 50);

  const findings = (await queryActiveFindings(widget.filters, actor.access)).filter(countsInFindingTotals);
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
    .slice(0, limit)
    .map(rule => ({ ...rule, href: widget.href({ ruleId: rule.ruleId }) }));

  return Response.json({ items: sorted, ...widget.meta });
}
