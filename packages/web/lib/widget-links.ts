/**
 * What a counting widget response says about the Scans page and about having nothing to count (ADR 0013).
 * The server builds every Scans link from the filters the viewer holds, so the page it opens counts what
 * the widget counted, and the widgets use the link as it comes. Client-safe, so the widgets share the shapes.
 */
import type { Access } from './access-model';
import type { WidgetFilters } from './dashboard-filters';
import type { WidgetSummary } from './dashboard-data';
import { markOutsideAccess, widgetAccessReason } from './outside-access';
import { buildScansHref, type ScansLinkOverrides } from './scans-link';
import type { Severity, StatMetric } from './types';

/** The filter dimensions whose values can be deleted from the install, and so can match nothing. */
export type GoneDimension = 'category' | 'rule' | 'tags';

/** Why a widget has nothing to count, in place of a number. Never the copy of a genuinely empty result. */
export interface WidgetNoCount {
  kind: 'outside-access' | 'gone';
  title: string;
  detail: string;
}

const GONE_DETAIL: Record<GoneDimension, string> = {
  category: 'This widget is filtered to a category that no longer exists',
  rule: 'This widget is filtered to a rule that no longer exists',
  tags: 'This widget is filtered to tags that no longer exist',
};

export function goneReason(dimension: GoneDimension): WidgetNoCount {
  return {
    kind: 'gone',
    title: 'Nothing to count',
    detail: `${GONE_DETAIL[dimension]}, so it counts nothing. That is not a clean result. Change the filter to count your findings.`,
  };
}

export function outsideAccessReason(filters: WidgetFilters, access: Access): WidgetNoCount | null {
  const reason = widgetAccessReason(filters, markOutsideAccess(access, filters));
  return reason ? { kind: 'outside-access', ...reason } : null;
}

/** The Scans link for `filters` as `access` sees them: a subscription or resource group the viewer's access
 *  does not reach is left out, so the page counts what the viewer's own numbers counted and names nothing
 *  outside their access. */
export function viewerScansHref(filters: WidgetFilters, access: Access, overrides: ScansLinkOverrides = {}): string {
  const held = markOutsideAccess(access, filters);
  const without = (values: string[] | undefined, drop: string[]) => {
    const dropped = new Set(drop.map(v => v.toLowerCase()));
    return values?.filter(v => !dropped.has(v.toLowerCase()));
  };
  return buildScansHref({
    ...filters,
    subscriptions: without(filters.subscriptions, held.subscriptions),
    resourceGroups: without(filters.resourceGroups, held.resourceGroups),
  }, overrides);
}

/** What a stat card's number opens on Scans. Metrics with no equivalent filter (posture %, categories
 *  healthy, rules scanned) open the Results tab under the widget's own filters. */
export function metricScansOverrides(metric: unknown): ScansLinkOverrides {
  switch (metric as StatMetric) {
    case 'total-findings': return { status: 'open' };
    case 'new-findings': return { status: 'new' };
    case 'fixed-findings': return { status: 'fixed' };
    case 'critical-findings': return { severity: 'critical' };
    case 'high-findings': return { severity: 'high' };
    default: return {};
  }
}

/** The summary route's answer: the numbers, and the Scans link behind each. */
export type WidgetSummaryResponse = Omit<WidgetSummary, 'perCategory' | 'perSubscription'> & {
  /** The link behind the widget's one number (a stat card's metric, the posture ring). */
  scansHref: string;
  severityHrefs: Record<Severity, string>;
  perCategory: Array<WidgetSummary['perCategory'][number] & { href: string }>;
  perSubscription: Array<WidgetSummary['perSubscription'][number] & { href: string }>;
};
