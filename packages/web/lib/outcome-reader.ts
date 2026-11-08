/**
 * Reading a rule's Outcome for a reader (#402): the one place that turns the Scope an address or a widget
 * names into Scopes, loads the finished scans and the management group tree, and asks `ruleOutcome()`
 * (`lib/rule-outcome.ts`) what the evidence says. The Rules tab (`lib/rules-tab-list.ts`), live posture
 * (`lib/dashboard-data.ts`) and the daily snapshots (`lib/db/snapshots.ts`) all read through it, so a rule
 * is passing in a posture number exactly when it is in the list `outcome=passing` opens.
 *
 * The Scope an Outcome is read at is the Scope named (`subscription`, `rg`, `managementGroup`), or with none,
 * Everything for a reader who holds it, otherwise each Scope they hold. A Scope the reader does not hold has
 * no covering scan for them and reads Unknown: Outcome never tells them about it.
 */
import { grantCovers, parseScope, type Access, type Scope } from '@/lib/access-model';
import { DIRECTORY_SUBSCRIPTION } from '@/lib/placement';
import { listHierarchyNodes } from '@/lib/db/management-group-hierarchy';
import type { HierarchyNode } from '@/lib/management-group-tree';
import { ruleOutcome, type OutcomeRule, type OutcomeScan, type RuleOutcome } from '@/lib/rule-outcome';
import { MANAGEMENT_GROUP_PATH } from '@/lib/run-scope';
import { listOutcomeScans } from '@/lib/scan-history';
import { newestCoveringScan } from '@/lib/scan-coverage';

/** The Scope an address or a widget names. Every list may be empty. */
export interface ScopeSelection {
  /** Subscription ids, or `directory`. */
  subscriptions: readonly string[];
  /** Resource group names, which mean nothing without a subscription. */
  resourceGroups: readonly string[];
  managementGroups: readonly string[];
}

export const NO_SCOPE_SELECTED: ScopeSelection = Object.freeze({ subscriptions: [], resourceGroups: [], managementGroups: [] });

/** What the Outcome was read at, for the line above the list. */
export interface OutcomeScope {
  kind: 'everything' | 'access' | 'selected';
  /** How many Scopes: one for Everything, otherwise the Scopes named or the reader holds. */
  count: number;
}

const EVERYTHING: Scope = { kind: 'everything', path: '/' };

/** The Scopes the selection names, or none when it names none that can be read. */
export function selectedScopes(selection: ScopeSelection): Scope[] {
  const directory = selection.subscriptions.some(s => s.toLowerCase() === DIRECTORY_SUBSCRIPTION);
  const subscriptions = selection.subscriptions.filter(s => s.toLowerCase() !== DIRECTORY_SUBSCRIPTION);
  const paths: string[] = [];
  if (directory) paths.push('@directory');
  // A resource group name means nothing without its subscription, so one given alone is ignored.
  if (selection.resourceGroups.length > 0 && subscriptions.length > 0) {
    for (const sub of subscriptions) for (const rg of selection.resourceGroups) paths.push(`/subscriptions/${sub}/resourceGroups/${rg}`);
  } else {
    for (const sub of subscriptions) paths.push(`/subscriptions/${sub}`);
  }
  for (const mg of selection.managementGroups) paths.push(`${MANAGEMENT_GROUP_PATH}${mg}`);
  return distinctScopes(paths.flatMap(path => parseScope(path) ?? []));
}

export function distinctScopes(scopes: readonly Scope[]): Scope[] {
  const seen = new Set<string>();
  return scopes.filter(s => !seen.has(s.path.toLowerCase()) && seen.add(s.path.toLowerCase()));
}

const heldBy = (access: Access, scope: Scope): boolean =>
  access.everything || access.grants.some(g => grantCovers(access, g, scope));

export interface OutcomeReading {
  scope: OutcomeScope;
  /** The Scopes the Outcome is read at. */
  scopes: readonly Scope[];
  /** Null for a disabled rule. `hasOpenFinding` is whether an open, unsuppressed finding sits inside the Scope and the reader's Access. */
  outcome(rule: OutcomeRule & { category: string }, hasOpenFinding: boolean): RuleOutcome | null;
}

export interface OutcomeReader {
  /** The management group tree the covering was read over. */
  hierarchy: readonly HierarchyNode[];
  /** Reads Outcomes at the Scope the selection names. Rules of one category share their covering scans. */
  at(selection: ScopeSelection): OutcomeReading;
}

/** Loads what covering needs once, so a widget that reads many Scopes does not read the scans for each. */
export async function loadOutcomeReader(access: Access): Promise<OutcomeReader> {
  const scansByCategory = await listOutcomeScans(access);
  const hierarchy = await listHierarchyNodes();
  return {
    hierarchy,
    at(selection) {
      const selected = selectedScopes(selection);
      const isSelected = selected.length > 0;
      const scopes: Scope[] = isSelected ? selected
        : access.everything ? [EVERYTHING]
        : distinctScopes(access.grants.map(g => g.scope));
      const scope: OutcomeScope = { kind: isSelected ? 'selected' : access.everything ? 'everything' : 'access', count: scopes.length };

      // The Scopes the reader holds are the only ones a scan can be said to cover for them.
      const covering = new Map<string, (OutcomeScan | undefined)[]>();
      const coveringScans = (category: string) => {
        let scans = covering.get(category);
        if (!scans) {
          scans = scopes.map(s => isSelected && !heldBy(access, s) ? undefined : newestCoveringScan(scansByCategory.get(category) ?? [], s, hierarchy));
          covering.set(category, scans);
        }
        return scans;
      };
      return { scope, scopes, outcome: (rule, hasOpenFinding) => ruleOutcome(rule, { hasOpenFinding, scans: coveringScans(rule.category) }) };
    },
  };
}
