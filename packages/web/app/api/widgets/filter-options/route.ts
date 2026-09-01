import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { listCategories } from '@/lib/db/categories';
import { loadRules } from '@/lib/rules';
import { listFindings } from '@/lib/db/findings';

export async function GET() {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const categories = listCategories();
  const allRules = loadRules();
  const tags = Array.from(new Set(allRules.flatMap(r => r.tags ?? []))).sort((a, b) => a.localeCompare(b));
  const allFindings = await listFindings();
  // Raw subscription ids only — display-name enrichment happens client-side via
  // /api/azure/subscriptions, same as findings-explorer-client.tsx does today.
  const subscriptions = Array.from(new Set(allFindings.map(f => f.subscriptionId).filter(Boolean))).sort();
  const resourceGroups = Array.from(new Set(allFindings.map(f => f.resourceGroup).filter(Boolean))).sort() as string[];

  // Only rules that actually have findings — same convention as explorer-data.ts's
  // policyOptions, so the dropdown doesn't list rules with nothing to filter to.
  const ruleById = new Map(allRules.map(r => [r.id, r]));
  const rules = [
    ...new Map(
      allFindings.map(f => [f.ruleId, { id: f.ruleId, name: ruleById.get(f.ruleId)?.name ?? f.title }]),
    ).values(),
  ].sort((a, b) => a.name.localeCompare(b.name));

  return Response.json({ categories, tags, subscriptions, resourceGroups, rules });
}
