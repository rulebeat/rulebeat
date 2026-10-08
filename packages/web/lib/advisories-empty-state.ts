import type { Rule, RuleKind } from './types';

export type AdvisoriesEmptyReason = 'none-enabled' | 'not-run' | 'clear' | 'incomplete';

export interface AdvisoriesEmptyState {
  reason: AdvisoriesEmptyReason;
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
 * Why the Advisories tab has nothing to list. Three situations look alike but mean different
 * things, so each gets its own words: no Advisory rule is enabled, the rules are enabled but have
 * not run, or they ran. A run that did not complete is not reported as a clean result.
 */
export function advisoriesEmptyState(rules: readonly RuleFacts[]): AdvisoriesEmptyState {
  const enabled = rules.filter(r => r.kind === 'advisory' && r.enabled);
  if (enabled.length === 0) {
    return {
      reason: 'none-enabled',
      title: 'No Advisory rules are enabled',
      hint: 'Mark a rule as an Advisory in its settings, or enable one. Its findings are listed here after the next scan.',
    };
  }
  const ran = enabled.filter(r => r.lastRunAt);
  if (ran.length === 0) {
    return {
      reason: 'not-run',
      title: 'Advisory rules have not run yet',
      hint: 'Run a scan, or wait for the next scheduled one, and any advisories found are listed here.',
    };
  }
  if (ran.some(r => r.lastRunStatus !== 'success')) {
    return {
      reason: 'incomplete',
      title: 'Some Advisory rules did not complete',
      hint: 'No advisories were listed, but at least one rule failed, was capped or was invalid on its last run. Check the Rules tab.',
    };
  }
  return {
    reason: 'clear',
    title: 'No open Advisories',
    hint: 'Every Advisory rule that ran returned nothing.',
  };
}
