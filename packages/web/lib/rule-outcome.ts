/**
 * A rule's Outcome at a Scope (#402), by formula v3's definition of passing. The one function for it: the
 * Rules tab and live posture (the dashboard summary and the daily snapshots, both through
 * `lib/outcome-reader.ts`) call it, so a rule never reads passing in one place and unknown in another.
 * Pure, no DB or Node imports.
 *
 *  - Only an enabled rule has an Outcome.
 *  - Failing: an open finding inside the Scope and the reader's Access. It holds even when the rule's last
 *    run was capped or failed, because the finding is still there.
 *  - Passing: no such finding, and the newest finished scan covering the Scope (`lib/scan-coverage.ts`) ran
 *    the rule without listing it in `incompleteRules`. A covering scan from before the rule existed or was
 *    last switched on (`enabledAt`) does not count, so it leaves the rule unknown, as does anything else.
 *  - An Activity rule is checked or unknown, never passing or failing: activity is not a pass or a fail.
 *
 * The caller finds the open findings and the covering scan; this decides what they say.
 */
import type { RuleKind } from '@/lib/types';
import type { CoverageScan } from '@/lib/scan-coverage';

export type RuleOutcome = 'passing' | 'failing' | 'unknown' | 'checked';

export const RULE_OUTCOMES: readonly RuleOutcome[] = ['passing', 'failing', 'unknown', 'checked'];

export interface OutcomeRule {
  id: string;
  enabled: boolean;
  kind?: RuleKind;
  /** When a scan last ran the rule (`rules.last_run_at`), the one thing a scan that recorded no rule list can be read by. */
  lastRunAt?: string;
  /** When the rule was last switched on. Absent: enabled since before that was recorded. */
  enabledAt?: string;
}

export interface OutcomeScan extends CoverageScan {
  /** The rules the scan listed as not completing: failed, capped or invalid. */
  incompleteRuleIds: readonly string[];
  /** The rules the scan ran. Null for a scan saved before scans recorded it. */
  ranRuleIds: readonly string[] | null;
}

export interface OutcomeEvidence {
  /** An open, unsuppressed finding of the rule sits inside the Scope and the reader's Access. */
  hasOpenFinding: boolean;
  /** The newest finished scan covering each Scope the Outcome is read at, undefined where none does. */
  scans: readonly (OutcomeScan | undefined)[];
}

/**
 * Whether the scan ran the rule and it completed, and finished after the rule was last switched on. A scan
 * that listed what it ran is read by that list. An earlier scan did not, so it is read by the rule's own last
 * run: the rule ran in it only when it last ran at or after the scan finished, and a rule that never ran was
 * not in any scan.
 */
function ranCleanly(rule: OutcomeRule, scan: OutcomeScan): boolean {
  if (scan.incompleteRuleIds.includes(rule.id)) return false;
  // A scan that finished before the rule was last switched on proves nothing now, even if it ran the rule then.
  if (rule.enabledAt !== undefined && scan.finishedAt < rule.enabledAt) return false;
  if (scan.ranRuleIds) return scan.ranRuleIds.includes(rule.id);
  return rule.lastRunAt !== undefined && rule.lastRunAt >= scan.finishedAt;
}

/** Null for a disabled rule. With several Scopes, every one has to be covered and clean to be passing. */
export function ruleOutcome(rule: OutcomeRule, evidence: OutcomeEvidence): RuleOutcome | null {
  if (!rule.enabled) return null;
  const proven = evidence.scans.length > 0 && evidence.scans.every(scan => scan !== undefined && ranCleanly(rule, scan));
  if (rule.kind === 'activity') return proven ? 'checked' : 'unknown';
  if (evidence.hasOpenFinding) return 'failing';
  return proven ? 'passing' : 'unknown';
}

/** Whether a rule's Outcome is what a `outcome=` value asks for. `checked` is passing or failing, and an Activity rule that was checked. */
export function outcomeMatches(outcome: RuleOutcome | null, wanted: RuleOutcome): boolean {
  if (outcome === null) return false;
  if (wanted === 'checked') return outcome !== 'unknown';
  return outcome === wanted;
}

export const OUTCOME_LABEL: Record<RuleOutcome, string> = {
  passing: 'Passing', failing: 'Failing', unknown: 'Unknown', checked: 'Checked',
};

export const OUTCOME_DESCRIPTION: Record<RuleOutcome, string> = {
  passing: 'No open finding here, and the newest scan that covered it ran this rule to the end.',
  failing: 'At least one open finding here that is not suppressed.',
  unknown: 'No open finding here, but no covering scan has run this rule to the end.',
  checked: 'A covering scan ran this activity rule to the end. Activity is not a pass or a fail.',
};
