import type { WidgetType } from './types';

/**
 * The size table (ADR 0012): the spans, in columns of the 12-column grid, each widget type may take.
 * It is the one place that says what widths a widget may have, and a dashboard Save is checked
 * against it. Pure data, so a client component shares it with the route that validates.
 *
 * Every type's nominal width (`defaultW` in the add-widget panel and the templates) is in its list.
 * A new widget type adds a row here; the type check makes forgetting one an error.
 */
export const WIDGET_SPANS: Record<WidgetType, readonly number[]> = {
  'stat-card': [3, 4, 6],
  'posture-ring': [4, 6],
  'trend': [6, 8, 12],
  'top-rules': [4, 5, 6, 12],
  'category-scorecard': [6, 12],
  'recent-findings': [6, 7, 12],
  'severity-breakdown': [4, 6],
  'subscription-scorecard': [6, 8, 12],
  'top-resources': [4, 6, 12],
  'coverage-freshness': [4, 6, 12],
  'new-vs-fixed': [6, 12],
  'activity-occurrences': [6, 12],
  'advisories': [6, 8, 12],
};

/** What a widget of a type this build does not know may be saved at: a half or the full width. */
export const UNKNOWN_TYPE_SPANS: readonly number[] = [6, 12];

/** The spans a known type may take, or null for a type this build does not know. */
export function allowedSpans(type: string): readonly number[] | null {
  return Object.hasOwn(WIDGET_SPANS, type) ? WIDGET_SPANS[type as WidgetType] : null;
}

/** The allowed span nearest to `w`, a tie going to the smaller. An unknown type snaps within 6 and 12. */
export function snapSpan(type: string, w: number): number {
  const spans = allowedSpans(type) ?? UNKNOWN_TYPE_SPANS;
  let best = spans[0]!;
  for (const span of spans) {
    if (Math.abs(span - w) < Math.abs(best - w)) best = span;
  }
  return best;
}
