/**
 * Codex review Phase 5, item 6: prove that dashboard widget counts, Results-tab (explorer)
 * filtering, and generated Scans click-through links agree on the same set of findings for every
 * filter dimension, and that the WidgetFilters serialization pair (buildSummaryParams /
 * parseWidgetFiltersFromSearchParams) round-trips.
 *
 * Three real, independent implementations are exercised directly (never re-implemented here):
 *  - queryActiveFindings() (lib/dashboard-data.ts) — what a dashboard widget counts
 *  - matchesExplorerFilters() (lib/explorer-filters.ts) — what the Results tab shows, extracted
 *    this session from findings-explorer-client.tsx's inline `passesGlobalFilters` closure so it's
 *    unit-testable outside a React render (see that file's `passesGlobalFilters` for the wiring)
 *  - buildScansHref() (lib/scans-link.ts) — the URL a widget click-through actually generates
 *
 * The one piece of glue that can't be imported is how scans/page.tsx's searchParams and
 * findings-explorer-client.tsx's useState initializers turn a URL back into filter state — that's
 * exactly the spot docs/engineering/conventions/ui.md's URL-sync lesson flags as fragile.
 * `toExplorerState()` below mirrors that plumbing by hand; keep it in sync if
 * either file's param handling changes.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { computeFingerprint } from '@rulebeat/core';
import type { Rule } from '@rulebeat/core';
import { syncScanFindings } from '@/lib/db/findings';
import { saveRules } from '@/lib/rules';
import { saveSuppressions, loadSuppressions, isActiveSuppression } from '@/lib/suppressions';
import { queryActiveFindings } from '@/lib/dashboard-data';
import { buildExplorerData } from '@/lib/explorer-data';
import {
  matchesExplorerFilters, getRecencyStatus, isWithinRange,
  type ExplorerFilterState,
} from '@/lib/explorer-filters';
import { buildScansHref, parseCategoryParam } from '@/lib/scans-link';
import {
  mergeWidgetFilters, parseWidgetFiltersFromSearchParams, buildSummaryParams,
  type WidgetFilters,
} from '@/lib/dashboard-filters';
import { resolveDateWindow } from '@/lib/date-window';
import type { Finding, Suppression } from '@/lib/types';
import { clearRules, resetDb } from '../helpers/db';

const RULE_A = 'xs-rule-a'; // security, tags: [baseline]
const RULE_B = 'xs-rule-b'; // security, tags: [cost-hygiene]
const RULE_C = 'xs-rule-c'; // cost, tags: [cost-hygiene]

function testRule(id: string, category: string, tags: string[]): Rule {
  return {
    id, name: `test rule ${id}`, description: 'test', category, severity: 'medium', enabled: true,
    type: 'custom', scope: { level: 'subscription' }, resourceTypes: [], conditions: [], tags,
  };
}

function finding(overrides: Partial<Finding> & { ruleId: string; category: string }): Finding {
  const resourceId = overrides.resourceId
    ?? `/subscriptions/${overrides.subscriptionId ?? 'sub-1'}/resourceGroups/${overrides.resourceGroup ?? 'rg-1'}/providers/Microsoft.Compute/virtualMachines/${overrides.ruleId}-${Math.random().toString(36).slice(2)}`;
  return {
    module: overrides.category,
    fingerprint: computeFingerprint(overrides.ruleId, resourceId),
    resourceType: 'microsoft.compute/virtualmachines',
    resourceName: resourceId.split('/').pop()!,
    subscriptionId: 'sub-1',
    title: 'test finding',
    description: 'test',
    evidence: {},
    recommendation: 'fix it',
    remediationSteps: [],
    detectedAt: new Date().toISOString(),
    severity: 'medium',
    ...overrides,
    resourceId,
  };
}

// Mirrors findings-explorer-client.tsx's useState initializers reading `initialFilters` (itself
// built by scans/page.tsx from searchParams) plus its default WidgetFilters -> component-state
// mapping. `queryActiveFindings()` always scopes to the DB's persisted status:'active', which is
// exactly the Results tab's default status:'open' (active + new, never fixed) — the two are the
// same underlying set by construction, not by coincidence, so 'open' is the only status tested here.
function toExplorerState(filters: WidgetFilters): ExplorerFilterState {
  const { from, to } = resolveDateWindow(filters.dateWindow);
  return {
    showSuppressed: !!filters.includeSuppressed,
    suppressedFingerprints: filters.includeSuppressed
      ? new Set()
      : new Set(loadSuppressions().filter(isActiveSuppression).map(s => s.fingerprint)),
    categories: new Set(filters.categories ?? []),
    severities: new Set(filters.severities ?? []),
    status: 'open',
    ruleIds: new Set(filters.ruleIds ?? []),
    subscriptions: new Set(filters.subscriptions ?? []),
    resourceGroups: new Set(filters.resourceGroups ?? []),
    locations: new Set(),
    tags: new Set(filters.tags ?? []),
    search: '',
    rangeFrom: from,
    rangeTo: to,
  };
}

function explorerFingerprints(filters: WidgetFilters): Set<string> {
  const state = toExplorerState(filters);
  return new Set(buildExplorerData().findings.filter(f => matchesExplorerFilters(f, state)).map(f => f.fingerprint));
}

function dashboardFingerprints(filters: WidgetFilters): Set<string> {
  return new Set(queryActiveFindings(filters).map(f => f.fingerprint));
}

function sorted(s: Set<string>): string[] {
  return [...s].sort();
}

let fpCritical: string, fpHigh: string, fpMedium: string, fpCost: string;

beforeEach(() => {
  resetDb();
  // clearRules(), not `saveRules([...loadRules(), ...])`: this file's beforeEach re-inserts the
  // same fixed rule ids (RULE_A/B/C) on every test, and resetDb() deliberately leaves the `rules`
  // table alone (see tests/helpers/db.ts) — appending would collide on the 2nd test in this file.
  clearRules();
  saveRules([
    testRule(RULE_A, 'security', ['baseline']),
    testRule(RULE_B, 'security', ['cost-hygiene']),
    testRule(RULE_C, 'cost', ['cost-hygiene']),
  ]);

  const critical = finding({ ruleId: RULE_A, category: 'security', severity: 'critical', subscriptionId: 'sub-1', resourceGroup: 'rg-1' });
  const high = finding({ ruleId: RULE_A, category: 'security', severity: 'high', subscriptionId: 'sub-1', resourceGroup: 'rg-2' });
  const medium = finding({ ruleId: RULE_B, category: 'security', severity: 'medium', subscriptionId: 'sub-2', resourceGroup: 'rg-1' });
  const cost = finding({ ruleId: RULE_C, category: 'cost', severity: 'low', subscriptionId: 'sub-2', resourceGroup: 'rg-3' });
  const toBeFixed = finding({ ruleId: RULE_A, category: 'security', severity: 'high', subscriptionId: 'sub-1', resourceGroup: 'rg-1' });
  fpCritical = critical.fingerprint; fpHigh = high.fingerprint; fpMedium = medium.fingerprint;
  fpCost = cost.fingerprint;

  syncScanFindings({
    scanId: 's1', category: 'security', ranRuleIds: [RULE_A, RULE_B],
    findings: [critical, high, medium, toBeFixed], finishedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  });
  syncScanFindings({
    scanId: 's1b', category: 'cost', ranRuleIds: [RULE_C],
    findings: [cost], finishedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  });
  // Drop toBeFixed from the next security sync so it resolves.
  syncScanFindings({
    scanId: 's2', category: 'security', ranRuleIds: [RULE_A, RULE_B],
    findings: [critical, high, medium], finishedAt: new Date(Date.now() - 1 * 86_400_000).toISOString(),
  });

  // Permanently suppress `high` — every agreement test below must therefore never see fpHigh.
  saveSuppressions([{ id: crypto.randomUUID(), fingerprint: high.fingerprint, resourceId: high.resourceId, reason: 'test', suppressedAt: '2026-01-01T00:00:00.000Z' } satisfies Suppression]);
});

function widgetFilters(overrides: Partial<WidgetFilters> = {}): WidgetFilters {
  return { dateWindow: { mode: 'relative', days: 7 }, ...overrides };
}

describe('dashboard vs. explorer agreement', () => {
  it('no filters: both surfaces show every active, non-suppressed finding', () => {
    const filters = widgetFilters();
    const dash = dashboardFingerprints(filters);
    const exp = explorerFingerprints(filters);
    expect(sorted(dash)).toEqual(sorted(exp));
    expect(sorted(dash)).toEqual([fpCost, fpCritical, fpMedium].sort());
  });

  it('category filter', () => {
    const filters = widgetFilters({ categories: ['security'] });
    expect(sorted(dashboardFingerprints(filters))).toEqual(sorted(explorerFingerprints(filters)));
    expect(sorted(dashboardFingerprints(filters))).toEqual([fpCritical, fpMedium].sort());
  });

  it('severity filter, combined with suppression: a suppressed finding never resurfaces just because its severity matches', () => {
    const filters = widgetFilters({ severities: ['critical', 'high'] });
    const dash = dashboardFingerprints(filters);
    const exp = explorerFingerprints(filters);
    expect(sorted(dash)).toEqual(sorted(exp));
    expect(dash.has(fpHigh)).toBe(false); // suppressed, even though its severity matches
    expect(sorted(dash)).toEqual([fpCritical]);
  });

  it('subscription filter', () => {
    const filters = widgetFilters({ subscriptions: ['sub-2'] });
    expect(sorted(dashboardFingerprints(filters))).toEqual(sorted(explorerFingerprints(filters)));
    expect(sorted(dashboardFingerprints(filters))).toEqual([fpCost, fpMedium].sort());
  });

  it('resource group filter', () => {
    const filters = widgetFilters({ resourceGroups: ['rg-1'] });
    expect(sorted(dashboardFingerprints(filters))).toEqual(sorted(explorerFingerprints(filters)));
    expect(sorted(dashboardFingerprints(filters))).toEqual([fpCritical, fpMedium].sort());
  });

  it('tag filter spans categories (rule tags, not finding.category)', () => {
    const filters = widgetFilters({ tags: ['cost-hygiene'] });
    expect(sorted(dashboardFingerprints(filters))).toEqual(sorted(explorerFingerprints(filters)));
    expect(sorted(dashboardFingerprints(filters))).toEqual([fpCost, fpMedium].sort());
  });

  it('a single-rule click-through (ruleIds) matches the rule\'s own findings only', () => {
    const filters = widgetFilters({ ruleIds: [RULE_A] });
    const dash = dashboardFingerprints(filters);
    const exp = explorerFingerprints(filters);
    expect(sorted(dash)).toEqual(sorted(exp));
    expect(sorted(dash)).toEqual([fpCritical]); // fpHigh is RULE_A too, but suppressed
  });

  it('includeSuppressed brings the suppressed finding back on both surfaces', () => {
    const filters = widgetFilters({ includeSuppressed: true });
    const dash = dashboardFingerprints(filters);
    const exp = explorerFingerprints(filters);
    expect(sorted(dash)).toEqual(sorted(exp));
    expect(dash.has(fpHigh)).toBe(true);
  });

  it('a combined multi-dimension filter (as a real widget would build) still agrees', () => {
    const filters = widgetFilters({ categories: ['security'], severities: ['critical', 'medium'], resourceGroups: ['rg-1'] });
    expect(sorted(dashboardFingerprints(filters))).toEqual(sorted(explorerFingerprints(filters)));
    expect(sorted(dashboardFingerprints(filters))).toEqual([fpCritical, fpMedium].sort());
  });
});

describe('recency classification (getRecencyStatus / isWithinRange)', () => {
  it('a finding first seen 3 days ago reads as "new" inside a 7d window and "ongoing" inside a 1d window', () => {
    const firstSeenAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const wide = resolveDateWindow({ mode: 'relative', days: 7 });
    const narrow = resolveDateWindow({ mode: 'relative', days: 1 });
    expect(getRecencyStatus({ status: 'active', firstSeenAt }, wide.from, wide.to)).toBe('new');
    expect(getRecencyStatus({ status: 'active', firstSeenAt }, narrow.from, narrow.to)).toBe('active');
  });

  it('a fixed finding reads as "fixed" regardless of window', () => {
    const firstSeenAt = new Date().toISOString();
    const { from, to } = resolveDateWindow({ mode: 'relative', days: 30 });
    expect(getRecencyStatus({ status: 'fixed', firstSeenAt }, from, to)).toBe('fixed');
  });

  it('isWithinRange is inclusive on both ends', () => {
    expect(isWithinRange('2026-06-05T10:00:00.000Z', '2026-06-01', '2026-06-10')).toBe(true);
    expect(isWithinRange('2026-06-01T00:00:00.000Z', '2026-06-01', '2026-06-10')).toBe(true);
    expect(isWithinRange('2026-06-10T23:59:59.000Z', '2026-06-01', '2026-06-10')).toBe(true);
    expect(isWithinRange('2026-06-11T00:00:00.000Z', '2026-06-01', '2026-06-10')).toBe(false);
  });
});

describe('date window never changes which findings count as "open"', () => {
  it('relative 1d, 7d, 30d, and a custom range all select the same open fingerprint set', () => {
    const base = [fpCost, fpCritical, fpMedium].sort();
    for (const dateWindow of [
      { mode: 'relative' as const, days: 1 },
      { mode: 'relative' as const, days: 7 },
      { mode: 'relative' as const, days: 30 },
      { mode: 'custom' as const, from: '2020-01-01', to: '2020-01-02' },
    ]) {
      const filters = widgetFilters({ dateWindow });
      expect(sorted(dashboardFingerprints(filters))).toEqual(base);
      expect(sorted(explorerFingerprints(filters))).toEqual(base);
    }
  });
});

describe('buildScansHref only ever emits params scans/page.tsx actually parses', () => {
  // scans/page.tsx's searchParams destructure (see the type on ScansPage) is the full contract —
  // this list is a deliberate hand-copy of it, kept next to the assertion that depends on it.
  const KNOWN_PARAMS = new Set([
    'category', 'tab', 'scan', 'run', 'compare', 'compareCategory', 'status', 'ruleId',
    'severity', 'subscription', 'rg', 'location', 'tags', 'window', 'from', 'to', 'q',
  ]);

  it('every param buildScansHref can produce is in the known set', () => {
    const filters = widgetFilters({
      categories: ['security'], severities: ['critical'], subscriptions: ['sub-1'],
      resourceGroups: ['rg-1'], tags: ['baseline'], ruleIds: [RULE_A],
      dateWindow: { mode: 'custom', from: '2026-01-01', to: '2026-01-31' },
    });
    const href = buildScansHref(filters, { status: 'fixed', search: 'vm' });
    const params = new URLSearchParams(href.split('?')[1]);
    for (const key of params.keys()) {
      expect(KNOWN_PARAMS.has(key)).toBe(true);
    }
  });
});

describe('widget click-throughs and multi-category dashboard filters (RB-QA-020, fixed)', () => {
  it('a dashboard filtered to two categories still scopes the click-through to those categories', () => {
    // Reproduces components/dashboard/widgets/{posture-ring,severity-breakdown,stat-card,
    // top-resources}-widget.tsx, none of which pass a `category` override to buildScansHref — see
    // grep of every buildScansHref call site. dashboard-filter-bar.tsx lets a user multi-select
    // categories, so `merged.categories` can genuinely have length > 1 reaching these widgets.
    const filters = widgetFilters({ categories: ['security', 'cost'] });
    const href = buildScansHref(filters); // no per-widget category override, same as those widgets

    const dash = dashboardFingerprints(filters); // correctly scoped to security+cost only
    const params = new URLSearchParams(href.split('?')[1]);
    expect(params.get('category')).toBe('security,cost');

    // What the Results tab actually shows after following the link: run the param back through
    // the same shared parser scans/page.tsx uses, feed it into matchesExplorerFilters, and check
    // it lands on the exact same fingerprint set the dashboard widget counted.
    const parsedCategories = parseCategoryParam(params.get('category') ?? undefined);
    const state = toExplorerState(filters);
    state.categories = new Set(parsedCategories);
    const exp = new Set(buildExplorerData().findings.filter(f => matchesExplorerFilters(f, state)).map(f => f.fingerprint));
    expect(sorted(dash)).toEqual(sorted(exp));
  });
});

describe('WidgetFilters serialization round-trips', () => {
  it('buildSummaryParams -> parseWidgetFiltersFromSearchParams recovers every dimension', () => {
    const original = widgetFilters({
      categories: ['security', 'cost'], subscriptions: ['sub-1', 'sub-2'], resourceGroups: ['rg-1'],
      tags: ['baseline', 'cost-hygiene'], severities: ['critical', 'high'], ruleIds: [RULE_A, RULE_B],
      includeSuppressed: true,
    });
    const params = buildSummaryParams(original);
    const roundTripped = parseWidgetFiltersFromSearchParams(params);
    expect(roundTripped).toEqual(original);
  });

  it('round-trips a custom date window', () => {
    const original = widgetFilters({ dateWindow: { mode: 'custom', from: '2026-02-01', to: '2026-02-14' } });
    const roundTripped = parseWidgetFiltersFromSearchParams(buildSummaryParams(original));
    expect(roundTripped.dateWindow).toEqual(original.dateWindow);
  });

  it('an empty filter set round-trips to the same effective (empty) filters', () => {
    const original = widgetFilters();
    const roundTripped = parseWidgetFiltersFromSearchParams(buildSummaryParams(original));
    expect(sorted(dashboardFingerprints(roundTripped))).toEqual(sorted(dashboardFingerprints(original)));
  });

  it('mergeWidgetFilters composed with the serialization round-trip still agrees with explorer filtering', () => {
    const dashboardLevel = widgetFilters({ subscriptions: ['sub-1'] });
    const merged = mergeWidgetFilters(dashboardLevel, { category: 'security', severities: ['critical'] });
    const roundTripped = parseWidgetFiltersFromSearchParams(buildSummaryParams(merged));
    expect(sorted(dashboardFingerprints(roundTripped))).toEqual(sorted(explorerFingerprints(roundTripped)));
    expect(sorted(dashboardFingerprints(roundTripped))).toEqual([fpCritical]);
  });
});
