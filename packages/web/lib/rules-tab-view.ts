/**
 * What the Rules tab shows (#402): the rules the server listed, in its order, narrowed by the one filter
 * that stays in the browser, free-text search. Everything else that decides membership is the server's
 * (`lib/rules-tab-list.ts`). The bulk selection is pruned against what this returns.
 */
import { matchesRuleSearch } from '@/lib/rule-filters';
import type { RulesTabEntry } from '@/lib/rules-tab-list';
import type { Rule } from '@/lib/types';

export interface ShownRule {
  /** The rule as the browser holds it, so a toggle shows at once. */
  policy: Rule;
  /** What the server read for the rule at the Scope. */
  entry: RulesTabEntry;
}

export function shownRules(
  entries: readonly RulesTabEntry[], policies: readonly Rule[], search: string, categoryLabel: (category: string) => string | undefined,
): ShownRule[] {
  const byId = new Map(policies.map(p => [p.id, p]));
  return entries.flatMap(entry => {
    const policy = byId.get(entry.id);
    return policy && matchesRuleSearch(policy, search, categoryLabel(policy.category)) ? [{ policy, entry }] : [];
  });
}
