/**
 * No widget writes its own limit copy: the Trend widget's and the Subscription scorecard's per-category
 * total caveat comes from lib/widget-limits.ts, and no file under components/dashboard/widgets repeats
 * a sentence the module holds.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WidgetSummary } from '@/lib/dashboard-data';
import { SubscriptionScorecardWidget } from '@/components/dashboard/widgets/subscription-scorecard-widget';
import { TrendWidget } from '@/components/dashboard/widgets/trend-widget';
import * as limits from '@/lib/widget-limits';
import { PER_CATEGORY_TOTAL_DETAIL, PER_CATEGORY_TOTAL_NOTE, WIDGET_LIMITS } from '@/lib/widget-limits';

let summary: WidgetSummary | null = null;

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }));
vi.mock('@/lib/hooks/use-subscription-names', () => ({ useSubscriptionNames: () => ({}) }));
vi.mock('@/lib/hooks/use-widget-fetch', () => ({
  useWidgetFetch: () => ({ data: summary, loading: false, failed: false, retry: () => undefined }),
}));

const SUB = '00000000-0000-0000-0000-000000000001';
const base = {
  current: {
    pct: 50, passingRules: 1, totalRules: 2, unknownRules: 0, activityRuleCount: 0,
    activeFindings: 1, severityCounts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, newInWindow: 0, fixedInWindow: 0,
  },
  deltaFindings: 0, perCategory: [], newVsFixedTrend: [], activityTrend: [],
  lastScanAt: null, baseline: null, deltaPct: null, baselineGap: null, trendIsCategoryScopedOnly: false, trendUnavailable: null,
  perSubscription: [{ subscriptionId: SUB, passingRules: 1, totalRules: 2, pct: 50, activeFindings: 1 }],
  trend: [{ date: '2026-11-01', pct: 50, passing: 1, total: 2 }, { date: '2026-11-02', pct: 50, passing: 1, total: 2 }],
} as unknown as WidgetSummary;

const trend = (subscriptions: string[]) => {
  summary = base;
  return renderToStaticMarkup(createElement(TrendWidget, {
    config: { category: 'security' }, filters: { categories: ['security'], subscriptions, dateWindow: { mode: 'relative', days: 7 } }, refreshKey: 0,
  }));
};
const scorecard = () => {
  summary = base;
  return renderToStaticMarkup(createElement(SubscriptionScorecardWidget, { config: {}, filters: { dateWindow: { mode: 'relative', days: 7 } }, refreshKey: 0 }));
};

describe('the per-category total caveat', () => {
  it('is worded once in the module, as true today', () => {
    expect(PER_CATEGORY_TOTAL_NOTE).toBe('Total is per category, not per subscription');
  });

  it('shows on the Subscription scorecard from the module, with its detail as the tooltip', () => {
    const html = scorecard();
    expect(html).toContain(PER_CATEGORY_TOTAL_NOTE);
    expect(html).toContain(`title="${PER_CATEGORY_TOTAL_DETAIL.replace(/'/g, '&#x27;')}"`);
    expect(html).not.toContain('Totals are per category');
  });

  it('shows on a single-subscription trend, and not on W2, which is not true yet', () => {
    const html = trend([SUB]);
    expect(html).toContain(PER_CATEGORY_TOTAL_NOTE);
    expect(html).not.toContain('A rule counts for every subscription or resource group');
  });

  it('is gone from the trend when no single subscription is picked', () => {
    expect(trend([])).not.toContain(PER_CATEGORY_TOTAL_NOTE);
  });
});

describe('widget source files', () => {
  const dir = join(__dirname, '..', '..', 'components', 'dashboard', 'widgets');
  const files = readdirSync(dir).filter(f => f.endsWith('.tsx'));
  const held: unknown[] = [...Object.values(limits), ...Object.values(WIDGET_LIMITS)];
  const sentences = held.filter(v => typeof v === 'string' && v.length > 30) as string[];

  it('finds the widget files and the module wording to check', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(sentences.length).toBeGreaterThan(5);
  });

  it.each(files)('%s writes none of the module\'s limit sentences itself', file => {
    const source = readFileSync(join(dir, file), 'utf8');
    for (const s of sentences) expect(source).not.toContain(s);
    expect(source).not.toMatch(/per category, not per subscription/i);
  });
});
