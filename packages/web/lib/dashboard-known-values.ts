/**
 * What exists now, for the dashboard bar to tell a value that no longer exists from one that does
 * (ADR 0013). Categories, tags and rules are the install's own and are the same for everyone.
 * Subscriptions come from RuleBeat's copy of the management group tree. Until that tree has been read
 * once there is no list to check against, so no subscription is called gone.
 */
import { listCategories } from '@/lib/db/categories';
import { getHierarchyStatus, listHierarchyNodes } from '@/lib/db/management-group-hierarchy';
import { DIRECTORY_SUBSCRIPTION } from '@/lib/placement';
import { loadRules } from '@/lib/rules';
import type { KnownValues } from '@/lib/dashboard-bar';

async function knownSubscriptions(): Promise<ReadonlySet<string> | undefined> {
  const status = await getHierarchyStatus();
  if (!status.lastSuccessAt) return undefined;
  const nodes = await listHierarchyNodes();
  // The Directory is a Scope value of its own, offered beside the subscriptions and never in the tree.
  return new Set([...nodes.filter(n => n.kind === 'subscription').map(n => n.id), DIRECTORY_SUBSCRIPTION]);
}

export async function loadKnownValues(): Promise<KnownValues> {
  const [categories, rules, subscription] = await Promise.all([listCategories(), loadRules(), knownSubscriptions()]);
  return {
    category: new Set(categories.map(c => c.id)),
    rule: new Set(rules.map(r => r.id)),
    tags: new Set(rules.flatMap(r => r.tags ?? [])),
    subscription,
  };
}
