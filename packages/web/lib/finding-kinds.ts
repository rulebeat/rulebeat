import type { RuleKind } from './types';

/**
 * Whether a rule, or a rule-scoped finding, counts toward the posture denominator: the
 * passing/total rule counts, the category and subscription scorecards, and a rule-scoped
 * widget's own pct. Only a state-kind rule can ever be scored zero-findings-is-passing (spec
 * 030); an activity rule has no such state, so it is excluded. Defined as "kind is state", not
 * "kind is not activity", so a future kind is excluded by construction rather than needing every
 * call site updated when it ships. An absent kind defaults to 'state'.
 */
export function countsTowardPosture(obj: { kind?: RuleKind }): boolean {
  return (obj.kind ?? 'state') === 'state';
}

/** Kinds that count toward a finding-level total (Results tiles, recent findings, top rules, top
 *  resources, dashboard stat cards, New vs Fixed, snapshot severity counts). Exported so the SQL
 *  form of the predicate (lib/db/finding-kinds-sql.ts) can build its `inArray` from the same
 *  list. */
export const FINDING_TOTAL_KINDS: readonly RuleKind[] = ['state', 'activity'];

/** Whether a finding counts toward a finding-level total. Both 'state' and 'activity' count
 *  (absent kind defaults to 'state'). Written as the positive list of kinds that count, not
 *  "everything except advisory", so a future kind is excluded the moment it exists. */
export function countsInFindingTotals(obj: { kind?: RuleKind }): boolean {
  return FINDING_TOTAL_KINDS.includes(obj.kind ?? 'state');
}
