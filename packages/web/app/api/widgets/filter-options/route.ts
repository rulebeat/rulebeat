import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { listCategories } from '@/lib/db/categories';
import { queryFilterOptions } from '@/lib/db/finding-views';
import { loadRules } from '@/lib/rules';

export async function GET() {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  try {
    const categories = await listCategories();
    const allRules = await loadRules();
    const tags = Array.from(new Set(allRules.flatMap(r => r.tags ?? []))).sort((a, b) => a.localeCompare(b));
    // Raw subscription ids only: display-name enrichment happens client-side via
    // /api/azure/subscriptions, same as the explorer does. Only rules that actually have findings
    // are listed, so the dropdown never offers a rule with nothing to filter to.
    const { subscriptions, resourceGroups, rules } = await queryFilterOptions();

    return Response.json({ categories, tags, subscriptions, resourceGroups, rules });
  } catch (err) {
    return serverError('Could not load the filter options', err);
  }
}
