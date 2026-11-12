/**
 * The Subscription scorecard's rows (posture formula v3, at the subscription and Directory levels). Pure,
 * no DB or Node imports: `computeWidgetSummary()` reads the rules, findings and tree and hands them in.
 *
 * Each row is graded by the rules whose scope overlaps it and by the findings placed inside it. The
 * findings are grouped by level once, and the rules by the shape of their scope, so the work per row is
 * a lookup per distinct scope and not a pass over every rule or every finding.
 */
import { accessReach, type Access } from './access-model';
import type { KnownSubscription } from './known-subscriptions';
import type { HierarchyNode } from './management-group-tree';
import { DIRECTORY_SUBSCRIPTION, isOutsidePlacement } from './placement';
import { narrowScopes, ruleOverlapsScopes } from './rule-overlap';
import { posturePct } from './posture-math';
import { compareRows, type SubscriptionRow } from './subscription-rows';
import type { Rule } from './types';

type CountedRule = Pick<Rule, 'id' | 'queryBackend' | 'scope' | 'lastRunStatus'>;

/** What the rows read of a finding: the rule it belongs to and where it sits. */
export interface PlacedRuleFinding {
  ruleId: string;
  subscriptionId: string;
  placement?: string;
}

export interface SubscriptionRowsInput {
  /** Every subscription to list, already limited to what the viewer holds and the filters name. */
  subscriptions: readonly KnownSubscription[];
  /** Whether the Directory has a row. */
  includeDirectory: boolean;
  /** The enabled Problem rules that match the rule-level filters. A row counts the ones that overlap it. */
  rules: readonly CountedRule[];
  /** The active, unsuppressed Problem findings that match every filter, within the viewer's Access. */
  findings: readonly PlacedRuleFinding[];
  /** The viewer's Access intersected with the subscription filter: what the rows are read over. */
  scopes: Access;
  hierarchy: readonly HierarchyNode[];
}

interface ScopeGroup {
  representative: CountedRule;
  size: number;
  succeeded: number;
}

/** Rules that share a backend class and a scope overlap the same levels, so they are tested once. */
function scopeKey(rule: Pick<Rule, 'queryBackend' | 'scope'>): string {
  const lower = (ids: readonly string[] | undefined) => (ids ?? []).map(i => i.trim().toLowerCase()).filter(Boolean).sort().join(',');
  return `${rule.queryBackend === 'microsoft-graph' ? 'graph' : 'arm'}|${lower(rule.scope?.subscriptions)}|${lower(rule.scope?.managementGroups)}`;
}

/** The level a finding counts against: a subscription key, the Directory, or none (a management group or unplaced finding). */
export function levelOf(f: PlacedRuleFinding): string | null {
  if (f.placement === 'directory') return DIRECTORY_SUBSCRIPTION;
  if (isOutsidePlacement(f.placement)) return null;
  const key = f.subscriptionId.trim().toLowerCase();
  return key === '' ? null : key;
}

export function buildSubscriptionRows(input: SubscriptionRowsInput): SubscriptionRow[] {
  const { rules, scopes, hierarchy } = input;

  const groups = new Map<string, ScopeGroup>();
  const groupOfRule = new Map<string, string>();
  const succeeded = new Set<string>();
  for (const rule of rules) {
    const key = scopeKey(rule);
    groupOfRule.set(rule.id, key);
    const group = groups.get(key) ?? { representative: rule, size: 0, succeeded: 0 };
    group.size++;
    if (rule.lastRunStatus === 'success') { group.succeeded++; succeeded.add(rule.id); }
    groups.set(key, group);
  }

  const findingsByLevel = new Map<string, Map<string, number>>();
  for (const f of input.findings) {
    const level = levelOf(f);
    if (level === null) continue;
    const perRule = findingsByLevel.get(level) ?? new Map<string, number>();
    perRule.set(f.ruleId, (perRule.get(f.ruleId) ?? 0) + 1);
    findingsByLevel.set(level, perRule);
  }

  const reach = accessReach(scopes);

  function grade(levelScopes: Access, level: string): Omit<SubscriptionRow, 'subscriptionId' | 'name' | 'directory' | 'yourGroupsOnly'> {
    const overlapping = new Set<string>();
    let total = 0;
    let proven = 0;
    for (const [key, group] of groups) {
      if (!ruleOverlapsScopes(group.representative, levelScopes, hierarchy)) continue;
      overlapping.add(key);
      total += group.size;
      proven += group.succeeded;
    }
    let failing = 0;
    let failingProven = 0;
    let findings = 0;
    for (const [ruleId, count] of findingsByLevel.get(level) ?? []) {
      findings += count;
      const key = groupOfRule.get(ruleId);
      if (key === undefined || !overlapping.has(key)) continue;
      failing++;
      if (succeeded.has(ruleId)) failingProven++;
    }
    const passing = proven - failingProven;
    return {
      passingRules: passing, totalRules: total, unknownRules: total - failing - passing,
      pct: posturePct(passing, total), activeFindings: findings,
    };
  }

  const rows: SubscriptionRow[] = input.subscriptions.map(sub => ({
    subscriptionId: sub.id,
    name: sub.name,
    directory: false,
    yourGroupsOnly: !scopes.everything && !reach.subscriptions.has(sub.key) && reach.resourceGroups.has(sub.key),
    ...grade(narrowScopes(scopes, [sub.key]), sub.key),
  }));
  if (input.includeDirectory) {
    rows.push({
      subscriptionId: DIRECTORY_SUBSCRIPTION, name: null, directory: true, yourGroupsOnly: false,
      ...grade(narrowScopes(scopes, [DIRECTORY_SUBSCRIPTION]), DIRECTORY_SUBSCRIPTION),
    });
  }
  return rows.sort((a, b) => compareRows(a, b));
}
