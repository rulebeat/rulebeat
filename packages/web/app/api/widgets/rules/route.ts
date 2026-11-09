import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { loadRules } from '@/lib/rules';
import { guardWidgetDashboard } from '@/lib/widget-reads';

export async function GET(req: Request) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;
  const refused = await guardWidgetDashboard(actor, new URL(req.url).searchParams);
  if (refused) return refused;
  const rules = (await loadRules())
    .map(r => ({ id: r.id, name: r.name, category: r.category, enabled: r.enabled }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return Response.json(rules);
}
