/**
 * What a counting widget response says about the Scans page and about having nothing to count (ADR 0013).
 * The server builds every Scans link from the filters the viewer holds, so the page it opens counts what
 * the widget counted, and the widgets use the link as it comes. Client-safe, so the widgets share the shapes.
 */
import type { Access } from './access-model';
import type { WidgetFilters } from './dashboard-filters';
import type { WidgetSummary } from './dashboard-data';
import { findingSubject, genericFilterParam } from './finding-view';
import { subscriptionValue, type FindingPlacement } from './placement';
import { markOutsideAccess, widgetAccessReason } from './outside-access';
import { buildScansHref, type ScansLinkOverrides } from './scans-link';
import type { Severity, StatMetric } from './types';

/** The filter dimensions whose values can be deleted from the install or from Azure, and so can match nothing. */
export type GoneDimension = 'category' | 'rule' | 'tags' | 'subscription' | 'resourceGroup';

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
  subscription: 'This widget is filtered to a subscription that no longer exists',
  resourceGroup: 'This widget is filtered to a resource group that no longer exists',
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

/** The resource a list row stands for. Its link names the resource exactly, not by a search that would also
 *  match a resource whose name merely contains it. */
export interface LinkedResource {
  resourceId?: string;
  resourceName?: string;
  resourceType?: string;
  dimensionKey?: string;
  subscriptionId: string;
  resourceGroup?: string;
  placement?: FindingPlacement | string;
  /** Other spellings of the name, type and group that findings of this same resource were stored with. The Scans
   *  filters match case-sensitively, and a rule that projects only the id stores the id's casing where a
   *  visual rule stores Resource Graph's lowercase, so a row that counts both must name both. */
  alsoStoredAs?: { resourceName?: string[]; resourceType?: string[]; resourceGroup?: string[] };
}

/** The Scans link for `filters` as `access` sees them: a subscription or resource group the viewer's access
 *  does not reach is left out, so the page counts what the viewer's own numbers counted and names nothing
 *  outside their access.
 *
 *  Use `numberScansHref` for a number a severity override can leave empty. */
export function viewerScansHref(
  filters: WidgetFilters,
  access: Access,
  overrides: ScansLinkOverrides = {},
  resource?: LinkedResource,
): string {
  const held = markOutsideAccess(access, filters);
  const without = (values: string[] | undefined, drop: string[]) => {
    const dropped = new Set(drop.map(v => v.toLowerCase()));
    return values?.filter(v => !dropped.has(v.toLowerCase()));
  };
  const href = buildScansHref({
    ...filters,
    subscriptions: without(filters.subscriptions, held.subscriptions),
    resourceGroups: without(filters.resourceGroups, held.resourceGroups),
  }, resource ? { ...overrides, subscription: subscriptionValue(resource) || overrides.subscription } : overrides);
  return resource ? withExactResource(href, resource) : href;
}

/** The link behind one number. A severity override narrows the widget's own severities, as the number does, so
 *  the link is null when the widget leaves that severity out: the number is zero, and replacing the widget's
 *  severities would open findings the number did not count. */
export function numberScansHref(filters: WidgetFilters, access: Access, overrides: ScansLinkOverrides = {}): string | null {
  const severity = overrides.severity as Severity | undefined;
  if (severity && filters.severities?.length && !filters.severities.includes(severity)) return null;
  return viewerScansHref(filters, access, overrides);
}

function distinct(first: string | undefined, more: readonly string[] | undefined): string[] {
  return [...new Set([first, ...(more ?? [])].filter((v): v is string => Boolean(v)))];
}

function withExactResource(href: string, resource: LinkedResource): string {
  const url = new URL(href, 'http://localhost');
  const also = resource.alsoStoredAs;
  const groups = distinct(resource.resourceGroup, also?.resourceGroup);
  if (groups.length) url.searchParams.set('rg', groups.join(','));
  url.searchParams.append('f', genericFilterParam('resourceName', distinct(findingSubject(resource), also?.resourceName)));
  const types = distinct(resource.resourceType, also?.resourceType);
  if (types.length) url.searchParams.append('f', genericFilterParam('resourceType', types));
  // A child resource's name is not unique inside a resource group (two SQL databases called `master` on
  // different servers), so the full id narrows it to the one resource. The search matches an id as text,
  // and a longer id of the same type under the same group cannot contain this one.
  if (resource.resourceId) url.searchParams.set('q', resource.resourceId);
  return `${url.pathname}${url.search}`;
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
  /** The link behind the widget's one number (a stat card's metric, the posture ring), null as for `severityHrefs`. */
  scansHref: string | null;
  /** Null for a severity the widget's own severities leave out: its number is zero and there is nothing to open. */
  severityHrefs: Record<Severity, string | null>;
  perCategory: Array<WidgetSummary['perCategory'][number] & { href: string }>;
  perSubscription: Array<WidgetSummary['perSubscription'][number] & { href: string }>;
};
