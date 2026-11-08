/**
 * Whether a widget's filters leave it nothing it could ever count because every value of one dimension
 * was deleted from the install (a category, a rule, a tag). Such a widget would otherwise read as a clean
 * result. A dimension with at least one value that still exists counts as usual.
 */
import { listCategories } from '@/lib/db/categories';
import { loadRules } from '@/lib/rules';
import type { WidgetFilters } from '@/lib/dashboard-filters';
import { goneReason, type GoneDimension, type WidgetNoCount } from '@/lib/widget-links';

export async function goneDimension(filters: WidgetFilters): Promise<GoneDimension | null> {
  const { categories, ruleIds, tags } = filters;
  if (!categories?.length && !ruleIds?.length && !tags?.length) return null;

  const rules = await loadRules();
  const known: Record<GoneDimension, Set<string> | null> = {
    category: categories?.length ? new Set((await listCategories()).map(c => c.id)) : null,
    rule: ruleIds?.length ? new Set(rules.map(r => r.id)) : null,
    tags: tags?.length ? new Set(rules.flatMap(r => r.tags ?? [])) : null,
  };
  const asked: Record<GoneDimension, readonly string[] | undefined> = { category: categories, rule: ruleIds, tags };
  for (const dimension of ['category', 'rule', 'tags'] as const) {
    const exists = known[dimension];
    if (exists && asked[dimension]!.every(value => !exists.has(value))) return dimension;
  }
  return null;
}

export async function goneNoCount(filters: WidgetFilters): Promise<WidgetNoCount | null> {
  const dimension = await goneDimension(filters);
  return dimension ? goneReason(dimension) : null;
}
