/**
 * The Rules tab's list (#402), from one server function: which rules the address lists, and each rule's
 * Outcome at the Scope it names, under the reader's Access. The Scans page calls it, and the browser no
 * longer decides what is listed (free-text search aside). Written to be called by anything that has to agree
 * with that list, such as the dashboard's equality test.
 *
 * Rules are listed by category, source, tags, severity, kind and `rules=enabled|disabled|all`, then by
 * Outcome. The Outcome is read at the effective Scope through `lib/outcome-reader.ts`, the same reader live
 * posture uses. An open finding counts only inside that Scope and the reader's Access.
 */
import {
  buildAccess, managementGroupIdOf, type Access, type ManagementGroupExpansion, type Scope, type ScopeGrant,
} from '@/lib/access-model';
import { queryRuleFindingCounts } from '@/lib/db/finding-views';
import type { HierarchyNode } from '@/lib/management-group-tree';
import { loadRules } from '@/lib/rules';
import { narrowRulesScope } from '@/lib/rule-scope-access';
import { outcomeMatches, type RuleOutcome } from '@/lib/rule-outcome';
import { loadOutcomeReader, selectedScopes, type OutcomeScope } from '@/lib/outcome-reader';
import { expandRuleGroup } from '@/lib/run-scope';
import { storedKind, type RulesTabQuery } from '@/lib/rules-tab-query';
import type { Rule } from '@/lib/types';

export interface RulesTabEntry {
  id: string;
  /** Null for a disabled rule: only an enabled rule has an Outcome. */
  outcome: RuleOutcome | null;
  /** Open, unsuppressed findings of the rule inside the Scope and the reader's Access. */
  findingCount: number;
}

/** What the Outcome was read at, for the line above the list. */
export type RulesTabScope = OutcomeScope;

export interface RulesTabList {
  entries: RulesTabEntry[];
  scope: RulesTabScope;
}

/** The Scopes as an Access, so the findings are narrowed by the same filter the Scans list uses. */
function scopesAsAccess(scopes: readonly Scope[], hierarchy: readonly HierarchyNode[]): Access {
  const grants: ScopeGrant[] = scopes.map(scope => ({ tenantId: '', scope, role: 'viewer' }));
  const expansions: ManagementGroupExpansion[] = scopes.filter(s => s.kind === 'managementGroup').map(scope => {
    const inside = expandRuleGroup(managementGroupIdOf(scope.path), hierarchy);
    return { tenantId: '', path: scope.path, role: 'viewer', groups: [...inside.groups], subscriptions: [...inside.subscriptions] };
  });
  return buildAccess(grants, null, expansions);
}

function matchesFilters(rule: Rule, query: RulesTabQuery): boolean {
  if (query.categories.length > 0 && !query.categories.includes(rule.category)) return false;
  if (query.sources.length > 0 && !query.sources.includes(rule.pack ?? rule.type)) return false;
  if (query.tags.length > 0 && !(rule.tags ?? []).some(t => query.tags.includes(t))) return false;
  if (query.severities.length > 0 && !query.severities.includes(rule.severity)) return false;
  if (query.kind && (rule.kind ?? 'state') !== storedKind(query.kind)) return false;
  if (query.rules === 'enabled' && !rule.enabled) return false;
  if (query.rules === 'disabled' && rule.enabled) return false;
  return true;
}

export async function listRulesTab(query: RulesTabQuery, access: Access): Promise<RulesTabList> {
  const reader = await loadOutcomeReader(access);
  const reading = reader.at(query);
  const selected = selectedScopes(query);

  const rules = narrowRulesScope(await loadRules(), access).filter(rule => matchesFilters(rule, query));
  const within = selected.length > 0 ? scopesAsAccess(selected, reader.hierarchy) : undefined;
  const counts = await queryRuleFindingCounts(access, within);

  const entries: RulesTabEntry[] = [];
  for (const rule of rules) {
    const findingCount = counts[rule.id] ?? 0;
    const outcome = reading.outcome(rule, findingCount > 0);
    if (query.outcome && !outcomeMatches(outcome, query.outcome)) continue;
    entries.push({ id: rule.id, outcome, findingCount });
  }
  return { entries, scope: reading.scope };
}
