import { loadRules } from './rules';
import { queryView } from './db/finding-views';
import { emptyView, type BuiltinField, type View } from './finding-view';
import type { WidgetFilters } from './dashboard-filters';
import type { AdvisoriesWidgetData } from './advisories-widget';

/** The widget's filter dimensions as the view filters the Advisories tab reads them. */
function filtersOf(filters: WidgetFilters): View['filters'] {
  const dims: [BuiltinField, string[] | undefined][] = [
    ['category', filters.categories], ['subscription', filters.subscriptions], ['resourceGroup', filters.resourceGroups],
    ['tags', filters.tags], ['severity', filters.severities], ['rule', filters.ruleIds],
  ];
  return dims.flatMap(([field, values]) => (values?.length ? [{ field, values }] : []));
}

/**
 * Open Advisories for the dashboard widget: active, not suppressed (unless the filter asks), narrowed
 * by every dimension in `filters`, ordered by severity (critical first), then most recently seen.
 * Reads the same server view as the Advisories tab (`queryView`), so the number the widget shows is
 * the number the tab shows for the same filters. Severity ranks by `SEVERITY_ORDER`, the one ordering
 * the dashboard code shares; the view engine sorts with it, and findings equal on both keys fall back
 * to fingerprint order.
 *
 * `hasAdvisoryRules` looks at the rules the filter could reach (category, rule, severity and rule
 * tag), so an empty list can say "no Advisory rules" rather than "nothing open". Resource group and
 * subscription are not properties of a rule, so they never narrow it.
 */
export async function queryAdvisoriesWidget(
  filters: WidgetFilters,
  opts: { limit: number },
): Promise<AdvisoriesWidgetData> {
  const view: View = {
    ...emptyView(),
    filters: filtersOf(filters),
    sort: { field: 'severity', dir: 'asc', then: { field: 'lastSeen', dir: 'desc' } },
    pageSize: opts.limit,
  };
  const [page, rules] = await Promise.all([
    queryView(view, { tab: 'advisories', showSuppressed: filters.includeSuppressed ?? false }),
    loadRules(),
  ]);

  const items = page.items.map(({ finding: f }) => ({
    fingerprint: f.fingerprint,
    ruleId: f.ruleId,
    ruleName: f.policyName ?? f.title,
    resourceId: f.resourceId,
    resourceName: f.resourceName ?? '',
    category: f.category,
    severity: f.severity,
    lastSeenAt: f.lastSeenAt,
  }));

  const hasAdvisoryRules = rules.some(r =>
    r.kind === 'advisory'
    && r.enabled
    && (!filters.categories?.length || filters.categories.includes(r.category))
    && (!filters.ruleIds?.length || filters.ruleIds.includes(r.id))
    && (!filters.severities?.length || filters.severities.includes(r.severity))
    && (!filters.tags?.length || (r.tags ?? []).some(t => filters.tags!.includes(t))),
  );

  return { items, total: page.total, hasAdvisoryRules };
}
