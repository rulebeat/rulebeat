/**
 * Every sentence a widget uses to state a limit on what its number means. Pure and client-safe, so the
 * server picks which notes apply (and sends them with the summary) and a component renders what it was
 * sent; no component writes limit wording of its own. docs/public/posture.md ("What each widget
 * counts") says the same things in prose.
 */
import { SEVERITY_ORDER } from './severity';
import type { Severity } from './types';

/** The heading of the full-page no-access state, and the first reason a posture has nothing to count. */
export const NO_ACCESS_HEADING = 'You have been given no access';

const PASS_SENTENCE = 'A rule passes when it has no open finding and its most recent run succeeded.';
const EDIT_SENTENCE = 'An edit to a rule counts from its next run.';

/** The limit note on the ring, the posture Stat Card and the Category scorecard for someone on Everything. */
export const EVERYONE_LINE = `${PASS_SENTENCE} ${EDIT_SENTENCE}`;

/**
 * Limits that qualify a single widget's number. W1 replaces the first sentence of the everyone line for
 * anyone without Everything; W2 to W5 are the Subscription Scorecard's and Scan Coverage's.
 */
export const WIDGET_LIMITS = {
  w1: 'A rule passes here when it has no open finding in your Access and its most recent run succeeded. That run may have covered a different part of the estate.',
  w2: 'A rule counts for every subscription or resource group its scope includes, even one with none of the resources it checks. A rule whose query picks subscriptions itself counts for all of them. Passing uses the rule\'s most recent run anywhere.',
  w3: 'A rule scoped to a management group counts for its subscriptions once RuleBeat has read the management group tree.',
  w4: 'Scan coverage ignores the Scope, tag, rule and Severity filters.',
  w5: 'Your resource groups only',
} as const;

/** The note a posture figure carries about what "passing" means for the viewer reading it. */
export function postureLimitNote(holdsEverything: boolean): string {
  return holdsEverything ? EVERYONE_LINE : `${WIDGET_LIMITS.w1} ${EDIT_SENTENCE}`;
}

export const TREND_RETENTION_NOTE = 'Trend points are kept for 365 days.';
export const ACTIVITY_RETENTION_NOTE = 'Activity occurrences are kept for 180 days.';

export type PostureEmptyReasonKey = 'no-access' | 'no-rules-here' | 'no-enabled-rules' | 'filter-left-nothing';

const POSTURE_EMPTY_REASONS: Record<PostureEmptyReasonKey, { title: string; detail: string }> = {
  'no-access': {
    title: NO_ACCESS_HEADING,
    detail: 'No subscription, resource group or the Directory has been shared with you, so there is nothing to count. Ask an Admin to give you access.',
  },
  'no-rules-here': {
    title: 'No rules here look at anything you hold',
    detail: 'Every enabled rule looks at parts of Azure your access does not include, so none can be counted for you.',
  },
  'no-enabled-rules': {
    title: 'No enabled rules',
    detail: 'Posture counts enabled Problem rules. Enable one in the Library and run a scan.',
  },
  'filter-left-nothing': {
    title: 'The filter left nothing to count',
    detail: 'No enabled rule matches the filters on this widget. Clear a filter to count more.',
  },
};

/** Why a ring or posture Stat Card has nothing to count, as the title and detail of a status. */
export function postureEmptyReason(key: PostureEmptyReasonKey): { title: string; detail: string } {
  return POSTURE_EMPTY_REASONS[key];
}

/** What a Category scorecard tile reads when none of its rules is counted. */
export function categoryEmptyLabel(holdsEverything: boolean): string {
  return holdsEverything ? POSTURE_EMPTY_REASONS['no-enabled-rules'].title : POSTURE_EMPTY_REASONS['no-rules-here'].title;
}

const SEVERITY_LABEL: Record<Severity, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };

/** What a posture measures under a Severity filter, or null without one: a rule fails on a finding of a
 *  picked severity only, and every counted rule stays in the count. */
export function severityMeasure(severities: readonly Severity[] | undefined): string | null {
  if (!severities?.length) return null;
  const names = SEVERITY_ORDER.filter(s => severities.includes(s)).map(s => SEVERITY_LABEL[s]);
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  return `Rules with no ${list} finding`;
}

/** The note on a widget scoped to chosen rules, when some of them are left out of the count. */
export function ruleSelectionNote(selected: number, notCounted: number): string | null {
  if (selected === 0 || notCounted === 0) return null;
  if (notCounted >= selected) return 'None of the selected rules is counted';
  return notCounted === 1
    ? '1 selected rule is not counted because it is disabled, no longer exists, or looks at nothing you hold'
    : `${notCounted} selected rules are not counted because they are disabled, no longer exist, or look at nothing you hold`;
}

export const RULE_FORM_SEVERITY_HELP = 'A change to the severity reaches open findings on the next scan.';
export const RULE_FORM_SAVE_NOTE = "Posture keeps this rule's last result until it next runs.";
