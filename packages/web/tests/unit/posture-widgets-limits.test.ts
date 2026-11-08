/**
 * The ring, the posture Stat Card and the Category scorecard state their limits (posture formula v3):
 * the notes the server sends are handed to the widget frame, a posture with nothing to count says why
 * instead of "0/0" or "No data", the Stat Card reads "Rules counted", "Categories healthy" needs a
 * counted rule, and each scorecard tile is "All passing" only when it is proven. Rendered on the
 * server, with the widget fetch hook replaced by the summary a response would hold and the notes hook
 * by a recorder of what the widget reports to its frame.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WidgetSummary } from '@/lib/dashboard-data';
import { CategoryScorecardWidget } from '@/components/dashboard/widgets/category-scorecard-widget';
import { PostureRingWidget } from '@/components/dashboard/widgets/posture-ring-widget';
import { StatCardWidget } from '@/components/dashboard/widgets/stat-card-widget';
import { STAT_METRICS } from '@/components/dashboard/widget-config-panel';
import { EVERYONE_LINE, postureEmptyReason, postureLimitNote } from '@/lib/widget-limits';
import type { StatMetric } from '@/lib/types';

let summary: WidgetSummary | null = null;
let reported: string[] | undefined;

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }));
vi.mock('@/lib/hooks/use-widget-fetch', () => ({
  useWidgetFetch: () => ({ data: summary, loading: false, failed: false, retry: () => undefined }),
}));
vi.mock('@/lib/hooks/use-widget-notes', () => ({
  useReportWidgetNotes: (notes: string[]) => { reported = notes; },
}));

const category = (over: Partial<WidgetSummary['perCategory'][number]> & { category: string }): WidgetSummary['perCategory'][number] => ({
  label: over.category, pct: null, activeFindings: 0, passing: 0, total: 0, unknown: 0, emptyLabel: null,
  lastScanAt: null, lastScanCoverage: null, lastScanIncompleteRules: [],
  ...over,
});

const summaryWith = (over: Partial<WidgetSummary> = {}): WidgetSummary => ({
  current: {
    pct: 75, passingRules: 3, totalRules: 4, unknownRules: 1, activityRuleCount: 0,
    activeFindings: 0, severityCounts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, newInWindow: 0, fixedInWindow: 0,
  },
  deltaFindings: 0, postureNotes: [EVERYONE_LINE], measure: null, emptyReason: null,
  perCategory: [], perSubscription: [], newVsFixedTrend: [], activityTrend: [],
  lastScanAt: null, baseline: null, deltaPct: null, baselineGap: null, trend: [], trendIsCategoryScopedOnly: false, trendUnavailable: null,
  ...over,
} as WidgetSummary);

const nothing = (key: Parameters<typeof postureEmptyReason>[0], over: Partial<WidgetSummary> = {}) => summaryWith({
  current: { ...summaryWith().current, pct: null, passingRules: 0, totalRules: 0, unknownRules: 0 },
  emptyReason: postureEmptyReason(key),
  ...over,
});

const window = { dateWindow: { mode: 'relative', days: 7 } } as const;
const ring = (s: WidgetSummary, config: object = {}) => {
  summary = s;
  return renderToStaticMarkup(createElement(PostureRingWidget, { config, filters: window, refreshKey: 0 }));
};
const card = (s: WidgetSummary, metric: StatMetric = 'posture-pct') => {
  summary = s;
  return renderToStaticMarkup(createElement(StatCardWidget, { config: { metric }, filters: window, refreshKey: 0 }));
};
const scorecard = (s: WidgetSummary) => {
  summary = s;
  return renderToStaticMarkup(createElement(CategoryScorecardWidget, { config: {}, filters: window, refreshKey: 0 }));
};

beforeEach(() => { reported = undefined; });

describe.each([
  ['the posture ring', (s: WidgetSummary) => ring(s)],
  ['the posture Stat Card', (s: WidgetSummary) => card(s)],
  ['the Category scorecard', (s: WidgetSummary) => scorecard(s)],
])('%s hands its limit notes to the widget frame', (_name, render) => {
  it('reports the everyone line, then the viewer\'s own wording, then nothing once the server sends none', () => {
    render(summaryWith({ postureNotes: [EVERYONE_LINE] }));
    expect(reported).toEqual([EVERYONE_LINE]);

    render(summaryWith({ postureNotes: [postureLimitNote(false), '2 selected rules are not counted because they are disabled, no longer exist, or look at nothing you hold'] }));
    expect(reported).toHaveLength(2);
    expect(reported![0]).toContain('in your Access');

    render(summaryWith({ postureNotes: [] }));
    expect(reported).toEqual([]);
  });
});

describe('the posture ring with nothing to count', () => {
  it.each([
    ['no-access', 'You have been given no access'],
    ['no-rules-here', 'No rules here look at anything you hold'],
    ['filter-left-nothing', 'The filter left nothing to count'],
  ] as const)('says %s, and never 0/0, "No scan data" or a bare "No data"', (key, title) => {
    const html = ring(nothing(key));
    expect(html).toContain(title);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('0/0');
    expect(html).not.toContain('No scan data');
    expect(html).not.toContain('No data');
  });

  it('still reports the notes, so the rule-scoped one is not lost with the figure', () => {
    ring(nothing('filter-left-nothing', { postureNotes: [EVERYONE_LINE, 'None of the selected rules is counted'] }));
    expect(reported).toContain('None of the selected rules is counted');
  });
});

describe('the posture ring under a Severity filter', () => {
  it('reads the measure in place of "checks passing"', () => {
    const html = ring(summaryWith({ measure: 'Rules with no High finding' }));
    expect(html).toContain('Rules with no High finding');
    expect(html).not.toContain('checks passing');
  });

  it('reads "checks passing" without one', () => {
    expect(ring(summaryWith())).toContain('checks passing');
  });
});

describe('the Stat Card', () => {
  it('shows the same empty reasons as the ring for the posture metric', () => {
    const html = card(nothing('no-rules-here'));
    expect(html).toContain('No rules here look at anything you hold');
    expect(html).not.toContain('0 of 0');
    expect(html).not.toContain('No data');
    expect(html).not.toContain('no checks enabled');
  });

  it('reads the measure under a Severity filter', () => {
    expect(card(summaryWith({ measure: 'Rules with no Critical or High finding' }))).toContain('Rules with no Critical or High finding');
  });

  it('reads "Rules counted" with "N passing · M unknown"', () => {
    const html = card(summaryWith(), 'rules-scanned');
    expect(html).toContain('Rules counted');
    expect(html).toContain('3 passing · 1 unknown');
    expect(html).not.toContain('rules scanned');
  });

  it('is labelled the same in the config panel, under the same saved key', () => {
    expect(STAT_METRICS).toContainEqual({ value: 'rules-scanned', label: 'Rules Counted' });
  });

  describe('Categories healthy', () => {
    const healthy = (perCategory: WidgetSummary['perCategory']) => card(summaryWith({ perCategory }), 'modules-healthy');

    it('does not count a category whose rules are all unknown, though it has no open finding', () => {
      const html = healthy([
        category({ category: 'security', passing: 2, total: 2, pct: 100 }),
        category({ category: 'cost', passing: 0, total: 2, unknown: 2, pct: 0 }),
      ]);
      expect(html).toContain('1/2');
      expect(html).toContain('categories healthy');
    });

    it('counts only categories with a counted rule, out of categories with a counted rule', () => {
      const html = healthy([
        category({ category: 'security', passing: 1, total: 1, pct: 100 }),
        category({ category: 'cost', emptyLabel: 'No enabled rules' }),
      ]);
      expect(html).toContain('1/1');
    });

    it('is 0/0 only when no category has a counted rule, and says what it counts', () => {
      const html = healthy([category({ category: 'cost', emptyLabel: 'No enabled rules' })]);
      expect(html).toContain('0/0');
      expect(html).toContain('categories with every counted rule passing');
    });
  });
});

describe('the Category scorecard tiles', () => {
  it('says "All passing" only when passing equals total and total is above 0', () => {
    const html = scorecard(summaryWith({ perCategory: [category({ category: 'security', passing: 3, total: 3, pct: 100 })] }));
    expect(html).toContain('All passing');
    expect(html).toContain('3/3');
  });

  it('says "N not yet proven" instead when a counted rule is unknown, even with no open finding', () => {
    const html = scorecard(summaryWith({ perCategory: [category({ category: 'security', passing: 2, total: 4, unknown: 2, pct: 50 })] }));
    expect(html).not.toContain('All passing');
    expect(html).toContain('2 not yet proven');
  });

  it('shows the open findings of a failing category, and no "not yet proven" when nothing is unknown', () => {
    const html = scorecard(summaryWith({ perCategory: [category({ category: 'security', passing: 1, total: 2, activeFindings: 3, pct: 50 })] }));
    expect(html).toContain('3 findings');
    expect(html).not.toContain('All passing');
    expect(html).not.toContain('not yet proven');
  });

  it('reads the empty label the server sent for a total of 0, never "No data"', () => {
    const everything = scorecard(summaryWith({ perCategory: [category({ category: 'cost', emptyLabel: 'No enabled rules' })] }));
    expect(everything).toContain('No enabled rules');
    expect(everything).not.toContain('No data');
    expect(everything).not.toContain('All passing');

    const scoped = scorecard(summaryWith({ perCategory: [category({ category: 'cost', emptyLabel: 'No rules here look at anything you hold' })] }));
    expect(scoped).toContain('No rules here look at anything you hold');
  });

  it('sorts by lowest unrounded ratio, then more findings, then name, with a total of 0 last', () => {
    const html = scorecard(summaryWith({
      perCategory: [
        category({ category: 'empty', label: 'Aaa empty', emptyLabel: 'No enabled rules' }),
        // 99.6% and 99.4% both round to 99% and 100%, so only the unrounded ratio orders them.
        category({ category: 'near', label: 'Near', passing: 249, total: 250, pct: 100 }),
        category({ category: 'nearer', label: 'Nearer', passing: 248, total: 250, pct: 99 }),
        category({ category: 'tie-few', label: 'Tie few', passing: 1, total: 2, activeFindings: 1, pct: 50 }),
        category({ category: 'tie-many', label: 'Zed tie many', passing: 1, total: 2, activeFindings: 4, pct: 50 }),
        category({ category: 'tie-name-b', label: 'Bravo', passing: 1, total: 2, activeFindings: 1, pct: 50 }),
      ],
    }));
    const order = ['Zed tie many', 'Bravo', 'Tie few', 'Nearer', 'Near', 'Aaa empty'].map(l => html.indexOf(`>${l}<`));
    expect(order.every(i => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('has no delta on a tile', () => {
    const html = scorecard(summaryWith({ perCategory: [category({ category: 'security', passing: 1, total: 2, pct: 50 })] }));
    expect(html.toLowerCase()).not.toContain('delta');
    expect(html).not.toContain(' vs ');
  });
});
