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
 * anyone without Everything; W2 is the Subscription scorecard's and a single-subscription trend's; W3
 * shows while a management group cannot be expanded; W4 says why a trend is not drawn; W5 is the marker
 * note where a line's counting changed, so it takes the date.
 */
export const WIDGET_LIMITS = {
  w1: 'A rule passes here when it has no open finding in your Access and its most recent run succeeded. That run may have covered a different part of the estate.',
  w2: 'A rule counts for every subscription or resource group its scope includes, even one with none of the resources it checks. A rule whose query picks subscriptions itself counts for all of them. Passing uses the rule\'s most recent run anywhere. A finding placed at a management group is counted in the footer, not against the subscriptions under it.',
  w3: 'A rule scoped to a management group counts for its subscriptions once RuleBeat has read the management group tree.',
  w4: 'A trend is not drawn with any filter other than category, the date window, or a single subscription or the Directory. Trend points are kept per category for the whole install, each subscription and the Directory.',
  w5: (date: string) => `Counted differently before ${date}. Earlier points use an older definition: see docs/public/posture.md.`,
} as const;

/**
 * The caveat on a single-subscription trend while a subscription is graded against its category's
 * install-wide total. W2 replaces it once the per-subscription count changes.
 */
export const PER_CATEGORY_TOTAL_NOTE = 'Total is per category, not per subscription';

/** What the Subscription scorecard says when it has no row to list. */
export const SUBSCRIPTIONS_EMPTY =
  'No subscriptions known yet. RuleBeat lists them once it has read the management group tree or found a finding.';

/** What a Subscription scorecard tile reads when no rule covers what it grades. */
export const NO_RULES_SUBSCRIPTION = 'No rules cover this subscription';
export const NO_RULES_DIRECTORY = 'No rules cover the Directory';

/** The label on a subscription row counted over only the resource groups the viewer holds in it. */
export const YOUR_GROUPS_ONLY = 'Your resource groups only';

/** The Subscription scorecard footer: findings placed at a management group or nowhere, which no row counts. */
export function outsideSubscriptionsNote(count: number): string {
  return `${count} ${count === 1 ? 'finding sits' : 'findings sit'} outside any subscription or the Directory`;
}

/** What a scorecard says when its limit cuts the list. */
export function showingLowestFirst(shown: number, total: number): string {
  return `Showing ${shown} of ${total}, lowest first`;
}

/** The note a posture figure carries about what "passing" means for the viewer reading it. */
export function postureLimitNote(holdsEverything: boolean): string {
  return holdsEverything ? EVERYONE_LINE : `${WIDGET_LIMITS.w1} ${EDIT_SENTENCE}`;
}

/** The title of the Trend widget's reason when a filter other than the ones a trend is kept for is set; W4 is its detail. */
export const TREND_FILTER_TITLE = 'No trend for this filter';

/** What the Trend widget says when a trend is served but no point is stored at that level yet. */
export const TREND_EMPTY_STATE = 'No trend points at this level yet. RuleBeat writes the first one when it next starts or when a rule, suppression or scan changes it.';

/** The note on a chart whose window reaches past the 365 days of trend points; `start` is the first day it draws. */
export function trendRetentionNote(start: string): string {
  return `Trend points are kept for 365 days, so this chart starts on ${start}.`;
}

/** The note on a chart whose window reaches past the 180 days of activity occurrences. */
export function activityRetentionNote(start: string): string {
  return `Activity occurrences are kept for 180 days, so this chart starts on ${start}.`;
}

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
