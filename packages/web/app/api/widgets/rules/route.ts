import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { loadRules } from '@/lib/rules';

export async function GET() {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;
  const rules = (await loadRules())
    .map(r => ({ id: r.id, name: r.name, category: r.category, enabled: r.enabled }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return Response.json(rules);
}
