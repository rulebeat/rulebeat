/**
 * Whether a widget's filters leave it nothing it could ever count because every value of one dimension
 * was deleted from the install (a category, a rule, a tag). Such a widget would otherwise read as a clean
 * result. A dimension with at least one value that still exists counts as usual.
 *
 * A category still exists for this purpose while its row does, or while a rule or a finding the viewer may see
 * carries its id: deleting a category removes only the row, and the Scans link of the widget still counts what
 * carries the id. A finding outside the viewer's access does not keep it, so the answer names nothing outside it.
 */
import { listCategories } from '@/lib/db/categories';
import { categoriesCarriedByFindings } from '@/lib/db/findings';
import { loadRules } from '@/lib/rules';
import type { Access } from '@/lib/access-model';
import type { WidgetFilters } from '@/lib/dashboard-filters';
import { goneReason, type GoneDimension, type WidgetNoCount } from '@/lib/widget-links';

async function categoriesInUse(asked: readonly string[], ruleCategories: readonly string[], access: Access): Promise<Set<string>> {
  const inUse = new Set<string>([...(await listCategories()).map(c => c.id), ...ruleCategories]);
  const stillAsked = asked.filter(id => !inUse.has(id));
  if (stillAsked.length) {
    for (const id of await categoriesCarriedByFindings(stillAsked, access)) inUse.add(id);
  }
  return inUse;
}

export async function goneDimension(filters: WidgetFilters, access: Access): Promise<GoneDimension | null> {
  const { categories, ruleIds, tags } = filters;
  if (!categories?.length && !ruleIds?.length && !tags?.length) return null;

  const rules = await loadRules();
  const known: Record<GoneDimension, Set<string> | null> = {
    category: categories?.length ? await categoriesInUse(categories, rules.map(r => r.category), access) : null,
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

export async function goneNoCount(filters: WidgetFilters, access: Access): Promise<WidgetNoCount | null> {
  const dimension = await goneDimension(filters, access);
  return dimension ? goneReason(dimension) : null;
}
