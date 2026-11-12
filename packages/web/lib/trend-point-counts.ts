/**
 * What the stored trend point of one category holds at every level (posture formula v3, finding-count
 * version 1): the whole install, each subscription RuleBeat knows and the Directory. Pure, no database
 * or Node imports: the queued writer (lib/db/snapshots.ts) reads the rules, the findings and the tree on
 * its transaction and hands them in.
 *
 * It shares the live readers' smallest pieces and not one forced function: a subscription or Directory
 * level is graded by `buildSubscriptionRows()`, and the install-wide level is the whole category, which
 * every rule overlaps (Everything overlaps every rule, including a management group rule the tree
 * cannot expand), so it needs no overlap test.
 */
import { everythingAccess } from './access-model';
import { countsTowardPosture, isActivityRule } from './finding-kinds';
import type { KnownSubscription } from './known-subscriptions';
import type { HierarchyNode } from './management-group-tree';
import { DIRECTORY_SUBSCRIPTION } from './placement';
import { posturePct } from './posture-math';
import { emptySeverityCounts } from './severity';
import { buildSubscriptionRows, levelOf, type PlacedRuleFinding } from './subscription-scorecard';
import type { Rule, Severity } from './types';

/** The key of the install-wide point, which is stored with an empty subscription id. */
export const INSTALL_LEVEL = '';

/** The finding-count version every point is written under: active, unsuppressed Problem findings placed in
 *  the level, each counted once, with severity counts by the finding's own severity. */
export const FINDING_COUNT_VERSION = 1;

export interface PointFinding extends PlacedRuleFinding {
  severity: string;
}

export interface LevelCounts {
  passingRules: number;
  totalRules: number;
  unknownRules: number;
  /** Null when no rule is counted. */
  posturePct: number | null;
  activityRuleCount: number;
  activeFindings: number;
  severityCounts: Record<Severity, number>;
}

export interface CategoryPointsInput {
  categoryId: string;
  /** Every rule of the install: the category's are counted, and an enabled rule's scope names subscriptions for the list. */
  rules: readonly Rule[];
  /** The category's active, unsuppressed Problem findings. */
  findings: readonly PointFinding[];
  /** The shared subscription list (lib/known-subscriptions.ts). */
  subscriptions: readonly KnownSubscription[];
  hierarchy: readonly HierarchyNode[];
}

function severityCountsOf(findings: readonly PointFinding[]): Record<Severity, number> {
  const counts = emptySeverityCounts();
  for (const f of findings) if (f.severity in counts) counts[f.severity as Severity]++;
  return counts;
}

/** The counts of every level of one category, keyed by `INSTALL_LEVEL`, a lower-case subscription id, or the Directory's value. */
export function categoryPoints(input: CategoryPointsInput): Map<string, LevelCounts> {
  const enabled = input.rules.filter(r => r.enabled && r.category === input.categoryId);
  const counted = enabled.filter(countsTowardPosture);
  const activityRuleCount = enabled.filter(isActivityRule).length;
  const out = new Map<string, LevelCounts>();

  const failing = new Set(input.findings.map(f => f.ruleId));
  let passing = 0;
  let unknown = 0;
  for (const rule of counted) {
    if (failing.has(rule.id)) continue;
    if (rule.lastRunStatus === 'success') passing++;
    else unknown++;
  }
  out.set(INSTALL_LEVEL, {
    passingRules: passing, totalRules: counted.length, unknownRules: unknown, posturePct: posturePct(passing, counted.length),
    activityRuleCount, activeFindings: input.findings.length, severityCounts: severityCountsOf(input.findings),
  });

  const byLevel = new Map<string, PointFinding[]>();
  for (const f of input.findings) {
    const level = levelOf(f);
    if (level === null) continue;
    const list = byLevel.get(level) ?? [];
    list.push(f);
    byLevel.set(level, list);
  }

  const rows = buildSubscriptionRows({
    subscriptions: input.subscriptions,
    includeDirectory: true,
    rules: counted,
    findings: input.findings,
    scopes: everythingAccess('admin'),
    hierarchy: input.hierarchy,
  });
  for (const row of rows) {
    const key = row.directory ? DIRECTORY_SUBSCRIPTION : row.subscriptionId.toLowerCase();
    out.set(key, {
      passingRules: row.passingRules, totalRules: row.totalRules, unknownRules: row.unknownRules, posturePct: row.pct,
      activityRuleCount, activeFindings: row.activeFindings, severityCounts: severityCountsOf(byLevel.get(key) ?? []),
    });
  }
  return out;
}
