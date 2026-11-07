/**
 * The Rules tab's list (#402), from one server function: which rules the address lists, and each rule's
 * Outcome at the Scope it names, under the reader's Access. The Scans page calls it, and the browser no
 * longer decides what is listed (free-text search aside). Written to be called by anything that has to agree
 * with that list, such as the dashboard's equality test.
 *
 * Rules are listed by category, source, tags, severity, kind and `rules=enabled|disabled|all`, then by
 * Outcome. The Outcome is `ruleOutcome()` (`lib/rule-outcome.ts`), read at the effective Scope:
 *
 *  - the Scope the address names (`subscription`, `rg`, `managementGroup`), or
 *  - with none, Everything for a reader who holds it, otherwise each Scope they hold.
 *
 * An open finding counts only inside that Scope and the reader's Access; a covering scan is the newest
 * finished one by `lib/scan-coverage.ts`, over the subscriptions the reader may see. A Scope the reader does
 * not hold has no covering scan for them and reads Unknown: Outcome never tells them about it.
 */
import {
  buildAccess, grantCovers, managementGroupIdOf, parseScope, type Access, type ManagementGroupExpansion, type Scope, type ScopeGrant,
} from '@/lib/access-model';
import { DIRECTORY_SUBSCRIPTION } from '@/lib/placement';
import { queryRuleFindingCounts } from '@/lib/db/finding-views';
import { listHierarchyNodes } from '@/lib/db/management-group-hierarchy';
import type { HierarchyNode } from '@/lib/management-group-tree';
import { loadRules } from '@/lib/rules';
import { narrowRulesScope } from '@/lib/rule-scope-access';
import { outcomeMatches, ruleOutcome, type RuleOutcome } from '@/lib/rule-outcome';
import { MANAGEMENT_GROUP_PATH, expandRuleGroup } from '@/lib/run-scope';
import { listOutcomeScans } from '@/lib/scan-history';
import { newestCoveringScan } from '@/lib/scan-coverage';
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
export interface RulesTabScope {
  kind: 'everything' | 'access' | 'selected';
  /** How many Scopes: one for Everything, otherwise the Scopes the address names or the reader holds. */
  count: number;
}

export interface RulesTabList {
  entries: RulesTabEntry[];
  scope: RulesTabScope;
}

const EVERYTHING: Scope = { kind: 'everything', path: '/' };

/** The Scopes the address names, or none when it names none that can be read. */
function selectedScopes(query: RulesTabQuery): Scope[] {
  const directory = query.subscriptions.some(s => s.toLowerCase() === DIRECTORY_SUBSCRIPTION);
  const subscriptions = query.subscriptions.filter(s => s.toLowerCase() !== DIRECTORY_SUBSCRIPTION);
  const paths: string[] = [];
  if (directory) paths.push('@directory');
  // A resource group name means nothing without its subscription, so one given alone is ignored.
  if (query.resourceGroups.length > 0 && subscriptions.length > 0) {
    for (const sub of subscriptions) for (const rg of query.resourceGroups) paths.push(`/subscriptions/${sub}/resourceGroups/${rg}`);
  } else {
    for (const sub of subscriptions) paths.push(`/subscriptions/${sub}`);
  }
  for (const mg of query.managementGroups) paths.push(`${MANAGEMENT_GROUP_PATH}${mg}`);
  return paths.flatMap(path => parseScope(path) ?? []);
}

function distinctScopes(scopes: readonly Scope[]): Scope[] {
  const seen = new Set<string>();
  return scopes.filter(s => !seen.has(s.path.toLowerCase()) && seen.add(s.path.toLowerCase()));
}

const heldBy = (access: Access, scope: Scope): boolean =>
  access.everything || access.grants.some(g => grantCovers(access, g, scope));

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
  const selected = distinctScopes(selectedScopes(query));
  const isSelected = selected.length > 0;
  const scopes: Scope[] = isSelected ? selected
    : access.everything ? [EVERYTHING]
    : distinctScopes(access.grants.map(g => g.scope));
  const scope: RulesTabScope = { kind: isSelected ? 'selected' : access.everything ? 'everything' : 'access', count: scopes.length };

  const rules = narrowRulesScope(await loadRules(), access).filter(rule => matchesFilters(rule, query));
  const hierarchy = scopes.some(s => s.kind === 'managementGroup') ? await listHierarchyNodes() : [];
  const within = isSelected ? scopesAsAccess(selected, hierarchy) : undefined;
  const counts = await queryRuleFindingCounts(access, within);
  const scansByCategory = await listOutcomeScans(access);

  // The Scopes the reader holds are the only ones a scan can be said to cover for them.
  const covering = (category: string) => scopes.map(s =>
    isSelected && !heldBy(access, s) ? undefined : newestCoveringScan(scansByCategory.get(category) ?? [], s, hierarchy));
  const scansOf = new Map<string, ReturnType<typeof covering>>();

  const entries: RulesTabEntry[] = [];
  for (const rule of rules) {
    if (!scansOf.has(rule.category)) scansOf.set(rule.category, covering(rule.category));
    const findingCount = counts[rule.id] ?? 0;
    const outcome = ruleOutcome(rule, { hasOpenFinding: findingCount > 0, scans: scansOf.get(rule.category)! });
    if (query.outcome && !outcomeMatches(outcome, query.outcome)) continue;
    entries.push({ id: rule.id, outcome, findingCount });
  }
  return { entries, scope };
}
