import type { Rule, RuleKind } from './types';

export type TabEmptyReason = 'none-enabled' | 'not-run' | 'clear' | 'incomplete';

export interface TabEmptyState {
  reason: TabEmptyReason;
  title: string;
  hint: string;
}

interface RuleFacts {
  kind?: RuleKind;
  enabled: boolean;
  lastRunStatus?: Rule['lastRunStatus'];
  lastRunAt?: string;
}

/**
 * Why a tab that lists one kind has nothing to list. Three situations look alike but mean
 * different things, so each gets its own words: no rule of the kind is enabled, the rules are
 * enabled but have not run, or they ran. A run that did not complete is not reported as a clean
 * result.
 */
function emptyReason(rules: readonly RuleFacts[], kind: RuleKind): TabEmptyReason {
  const enabled = rules.filter(r => (r.kind ?? 'state') === kind && r.enabled);
  if (enabled.length === 0) return 'none-enabled';
  const ran = enabled.filter(r => r.lastRunAt);
  if (ran.length === 0) return 'not-run';
  return ran.some(r => r.lastRunStatus !== 'success') ? 'incomplete' : 'clear';
}

const ADVISORIES_COPY: Record<TabEmptyReason, Omit<TabEmptyState, 'reason'>> = {
  'none-enabled': {
    title: 'No Advisory rules are enabled',
    hint: 'Mark a rule as an Advisory in its settings, or enable one. Its findings are listed here after the next scan.',
  },
  'not-run': {
    title: 'Advisory rules have not run yet',
    hint: 'Run a scan, or wait for the next scheduled one, and any advisories found are listed here.',
  },
  incomplete: {
    title: 'Some Advisory rules did not complete',
    hint: 'No advisories were listed, but at least one rule failed, was capped or was invalid on its last run. Check the Rules tab.',
  },
  clear: {
    title: 'No open Advisories',
    hint: 'Every Advisory rule that ran returned nothing.',
  },
};

const ACTIVITY_COPY: Record<TabEmptyReason, Omit<TabEmptyState, 'reason'>> = {
  'none-enabled': {
    title: 'No Logs rules are enabled',
    hint: 'Activity findings come from rules that query Log Analytics. Enable one and what it finds is listed here after the next scan.',
  },
  'not-run': {
    title: 'Logs rules have not run yet',
    hint: 'Run a scan, or wait for the next scheduled one, and any activity found is listed here.',
  },
  incomplete: {
    title: 'Some Logs rules did not complete',
    hint: 'No activity was listed, but at least one rule failed, was capped or was invalid on its last run. Check the Rules tab.',
  },
  clear: {
    title: 'No activity found',
    hint: 'Every Logs rule that ran returned nothing.',
  },
};

/** Why the Advisories tab has nothing to list. */
export function advisoriesEmptyState(rules: readonly RuleFacts[]): TabEmptyState {
  const reason = emptyReason(rules, 'advisory');
  return { reason, ...ADVISORIES_COPY[reason] };
}

/** Why the Activity tab has nothing to list. An Activity finding comes from a Logs rule, the only
 *  rules of the 'activity' kind. */
export function activityEmptyState(rules: readonly RuleFacts[]): TabEmptyState {
  const reason = emptyReason(rules, 'activity');
  return { reason, ...ACTIVITY_COPY[reason] };
}
