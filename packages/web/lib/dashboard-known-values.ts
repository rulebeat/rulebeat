/**
 * What exists now, for the dashboard bar to tell a value that no longer exists from one that does
 * (ADR 0013). Categories, tags and rules are the install's own and are the same for everyone. Scope
 * values are not listed: nothing local says a subscription has gone, so the bar never calls one so.
 */
import { listCategories } from '@/lib/db/categories';
import { loadRules } from '@/lib/rules';
import type { KnownValues } from '@/lib/dashboard-bar';

export async function loadKnownValues(): Promise<KnownValues> {
  const [categories, rules] = await Promise.all([listCategories(), loadRules()]);
  return {
    category: new Set(categories.map(c => c.id)),
    rule: new Set(rules.map(r => r.id)),
    tags: new Set(rules.flatMap(r => r.tags ?? [])),
  };
}
