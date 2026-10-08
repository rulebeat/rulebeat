import type { Severity } from './types';

/** One open Advisory as the dashboard widget lists it. */
export interface AdvisoryWidgetItem {
  fingerprint: string;
  ruleId: string;
  ruleName: string;
  resourceId?: string;
  resourceName: string;
  category: string;
  severity: Severity;
  /** ISO date the Advisory needs action by, when its rule names a Deadline column and the row held one. */
  deadline?: string;
  /** Past its Deadline as of the request. Read-time only; never stored and never counted. */
  overdue: boolean;
}

/** What `/api/widgets/advisories` returns. */
export interface AdvisoriesWidgetData {
  /** Open Advisories in scope, Overdue first. Capped at the request's `limit`. */
  items: AdvisoryWidgetItem[];
  /** Every open Advisory in scope, so the widget can say how many the cap hid. */
  total: number;
  /** Whether an enabled Advisory rule exists within the filter's rule scope. False and an empty
   *  list means there is nothing that could produce one; true and an empty list means the rules
   *  ran (or are yet to) and found nothing. */
  hasAdvisoryRules: boolean;
}

export const ADVISORIES_WIDGET_DEFAULT_LIMIT = 10;
export const ADVISORIES_WIDGET_MAX_LIMIT = 50;

/** A Deadline is a calendar date, often stored at midnight UTC, so it is shown in UTC and with its
 *  year: in a local zone behind UTC the same value would read as the day before. Matches the
 *  Advisories tab. */
export function formatDeadline(iso?: string): string {
  if (!iso) return 'None';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'None';
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export type AdvisoriesWidgetView = 'loading' | 'unavailable' | 'no-rules' | 'none-open' | 'list';

/**
 * Which state the widget renders. A failed fetch is 'unavailable' whatever data an earlier fetch
 * left behind, and a missing body is never read as "no Advisories": the empty states only run once
 * a fetch has actually succeeded with a body.
 */
export function advisoriesWidgetView(
  state: { loading: boolean; failed: boolean; data: AdvisoriesWidgetData | null },
): AdvisoriesWidgetView {
  if (state.loading) return 'loading';
  if (state.failed || !state.data) return 'unavailable';
  if (state.data.items.length > 0) return 'list';
  return state.data.hasAdvisoryRules ? 'none-open' : 'no-rules';
}

/** The two empty states, each saying why the list is empty. */
export const ADVISORIES_WIDGET_EMPTY = {
  'no-rules': {
    title: 'No Advisory rules are enabled',
    hint: 'Mark a rule as an Advisory in its settings, or enable one. If this dashboard or widget is filtered, check that the filter includes an Advisory rule.',
  },
  'none-open': {
    title: 'No open Advisories',
    hint: 'The Advisory rules in scope have nothing open.',
  },
} as const;
