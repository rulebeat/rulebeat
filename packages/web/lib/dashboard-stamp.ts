import type { AppUser } from './db/users';
import type { Access } from './access-model';
import { listCategories } from './db/categories';
import { loadRules } from './rules';
import { buildAsSeenByStamp, effectiveStampFilters } from './as-seen-by';
import type { AsSeenByStamp, DashboardConfig } from './types';

/**
 * The stamp for one dashboard response: the effective filters (saved, then the page's address), the names
 * resolved on the server, and the person's own `access` from the same request that reads the definition.
 */
export async function loadDashboardStamp(
  actor: Pick<AppUser, 'name' | 'email'> & { access: Access },
  config: DashboardConfig,
  url: URLSearchParams,
): Promise<AsSeenByStamp> {
  const [categories, rules] = await Promise.all([listCategories(), loadRules()]);
  const now = new Date();
  return buildAsSeenByStamp({
    person: { name: actor.name, email: actor.email },
    access: actor.access,
    filters: effectiveStampFilters(config, url, now),
    now,
    categoryLabels: Object.fromEntries(categories.map(c => [c.id, c.label])),
    ruleNames: Object.fromEntries(rules.map(r => [r.id, r.name])),
  });
}
