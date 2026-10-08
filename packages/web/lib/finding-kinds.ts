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

/** Whether a rule is an 'activity' rule, the ones `activityRuleCount` counts. A positive test on
 *  purpose: "not state" would also count Advisory rules. */
export function isActivityRule(obj: { kind?: RuleKind }): boolean {
  return obj.kind === 'activity';
}

/** Kinds that count toward a finding-level total (Results tiles, recent findings, top rules, top
 *  resources, dashboard stat cards, New vs Fixed, snapshot severity counts). Exported so the SQL
 *  form of the predicate (lib/db/finding-kinds-sql.ts) can build its `inArray` from the same
 *  list. */
export const FINDING_TOTAL_KINDS: readonly RuleKind[] = ['state'];

/** Whether a finding counts toward a finding-level total. Only 'state' counts (absent kind
 *  defaults to 'state'), so these totals agree with posture: an activity finding is something
 *  that happened, not something still wrong. Written as the positive list of kinds that count,
 *  so a future kind is excluded the moment it exists. */
export function countsInFindingTotals(obj: { kind?: RuleKind }): boolean {
  return FINDING_TOTAL_KINDS.includes(obj.kind ?? 'state');
}

/** Kinds whose findings resolve when their rule's own run succeeds and no longer returns them.
 *  An activity finding never resolves: it ages out of a read-time window instead. Positive list,
 *  not "not activity", so a future kind never starts resolving by accident. */
export const RESOLVABLE_KINDS: readonly RuleKind[] = ['state', 'advisory'];

/** Kinds a scheduled scan may announce to a notification channel. An Advisory is left out until a
 *  channel can opt in to receiving them. Absent kind defaults to 'state'. */
export const NOTIFIABLE_KINDS: readonly RuleKind[] = ['state', 'activity'];

export function isNotifiable(obj: { kind?: RuleKind }): boolean {
  return NOTIFIABLE_KINDS.includes(obj.kind ?? 'state');
}

/** Kinds a rule's "resources affected" figure and "clear findings" action cover: every kind that
 *  resolves. A per-rule figure, not a total, so an Advisory rule shows its own affected count
 *  even though its findings are left out of every total above. */
export function countsAsAffected(obj: { kind?: RuleKind }): boolean {
  return RESOLVABLE_KINDS.includes(obj.kind ?? 'state');
}

/** What the Results tab lists: everything but Advisories, as before they existed. */
export const RESULTS_KINDS: readonly RuleKind[] = ['state', 'activity'];

/** What the Advisories tab lists. */
export const ADVISORY_KINDS: readonly RuleKind[] = ['advisory'];

/** Whether an object's kind is one of `kinds` (an absent kind is 'state'). */
export function isOfKind(obj: { kind?: RuleKind }, kinds: readonly RuleKind[]): boolean {
  return kinds.includes(obj.kind ?? 'state');
}

/** The one place the user-facing words for a kind live. 'state' is only the code name for a Problem. */
export const KIND_LABEL: Record<RuleKind, string> = {
  state: 'Problem',
  activity: 'Activity',
  advisory: 'Advisory',
};

/** One sentence per kind, for a tooltip or the rule form's help text. */
export const KIND_DESCRIPTION: Record<RuleKind, string> = {
  state: 'Each result is something wrong. It counts against posture.',
  activity: 'Each result is something that happened. It is not scored.',
  advisory: 'Each result is something to know about and act on. It is listed on the Advisories tab and never counts against posture.',
};
