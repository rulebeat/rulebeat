import { queryActiveFindings } from './dashboard-data';
import { loadRules } from './rules';
import { ADVISORY_KINDS } from './finding-kinds';
import { applyView, emptyView, type View } from './finding-view';
import type { WidgetFilters } from './dashboard-filters';
import type { AdvisoriesWidgetData } from './advisories-widget';

/**
 * Open Advisories for the dashboard widget: active, not suppressed (unless the filter asks), narrowed
 * by every dimension in `filters`, ordered by severity (critical first), then most recently seen.
 * Reads the findings lifecycle table with the same filters as the Advisories tab, and runs them
 * through the same view engine (`applyView`), so a view the tab can express is one the widget can.
 * Severity ranks by `SEVERITY_ORDER`, the one ordering the dashboard code shares; the engine sorts
 * with it.
 *
 * `hasAdvisoryRules` looks at the rules the filter could reach (category, rule, severity and rule
 * tag), so an empty list can say "no Advisory rules" rather than "nothing open". Resource group and
 * subscription are not properties of a rule, so they never narrow it.
 */
export async function queryAdvisoriesWidget(
  filters: WidgetFilters,
  opts: { limit: number },
): Promise<AdvisoriesWidgetData> {
  const [active, rules] = await Promise.all([queryActiveFindings(filters), loadRules()]);
  const ruleName = new Map(rules.map(r => [r.id, r.name]));

  const view: View = {
    ...emptyView(),
    filters: [{ field: 'kind', values: [...ADVISORY_KINDS] }],
    sort: { field: 'severity', dir: 'asc', then: { field: 'lastSeen', dir: 'desc' } },
    pageSize: opts.limit,
  };
  // Suppression is already applied by queryActiveFindings, which honours the widget's own filter.
  const page = applyView(active, view);
  const items = page.items.map(({ finding: f }) => ({
    fingerprint: f.fingerprint,
    ruleId: f.ruleId,
    ruleName: ruleName.get(f.ruleId) ?? f.title,
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
