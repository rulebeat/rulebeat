/**
 * ADR 0013: what sits under a posture figure when it has a baseline, has none, or the person's access
 * serves no trend level. The live ring and number always show; only the delta slot changes. Rendered on
 * the server, in the style of library-requests-render.test.ts, with the widget fetch hook replaced by
 * the summary a response would hold.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WidgetSummary } from '@/lib/dashboard-data';
import { PostureRingWidget } from '@/components/dashboard/widgets/posture-ring-widget';
import { StatCardWidget } from '@/components/dashboard/widgets/stat-card-widget';
import { WidgetUnavailable } from '@/components/dashboard/widgets/widget-unavailable';
import { trendUnavailableMessage } from '@/lib/trend-scope';

let summary: WidgetSummary | null = null;

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }));
vi.mock('@/lib/hooks/use-widget-fetch', () => ({
  useWidgetFetch: () => ({ data: summary, loading: false, failed: false, retry: () => undefined }),
}));

const summaryWith = (over: Partial<WidgetSummary>): WidgetSummary => ({
  current: {
    pct: 99, passingRules: 239, totalRules: 240, unknownRules: 1, activityRuleCount: 0,
    activeFindings: 0, severityCounts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, newInWindow: 0, fixedInWindow: 0,
  },
  deltaFindings: 0, perCategory: [], perSubscription: [], newVsFixedTrend: [], activityTrend: [],
  lastScanAt: null, baseline: null, deltaPct: null, baselineGap: null, trend: [], trendIsCategoryScopedOnly: false, trendUnavailable: null,
  ...over,
} as WidgetSummary);

const ring = (s: WidgetSummary) => {
  summary = s;
  return renderToStaticMarkup(createElement(PostureRingWidget, { config: { showDelta: true }, filters: { dateWindow: { mode: 'relative', days: 7 } }, refreshKey: 0 }));
};
const card = (s: WidgetSummary) => {
  summary = s;
  return renderToStaticMarkup(createElement(StatCardWidget, { config: { metric: 'posture-pct' }, filters: { dateWindow: { mode: 'relative', days: 7 } }, refreshKey: 0 }));
};

const withBaseline = summaryWith({ deltaPct: -1, baseline: { pct: 100, date: '2026-10-01' } });
const withGap = summaryWith({ baselineGap: { needed: '2026-10-31', earliest: '2026-11-03', level: 'install' } });
const subscriptionGap = summaryWith({ baselineGap: { needed: '2026-10-31', earliest: '2026-11-03', level: 'subscription' } });
// Both set, so the test holds the trend-unavailable message to win over a missing-baseline one.
const noLevel = summaryWith({ trendUnavailable: 'no-whole-subscription', baselineGap: { needed: '2026-10-31', earliest: null, level: 'install' } });

describe('WidgetUnavailable with a reason', () => {
  const reason = { title: 'A known reason', detail: 'Why there is nothing to show.' };

  it('is a status with no Retry and no warning icon, over the tile or inline', () => {
    for (const html of [
      renderToStaticMarkup(createElement(WidgetUnavailable, { reason })),
      renderToStaticMarkup(createElement(WidgetUnavailable, { reason, inline: true })),
    ]) {
      expect(html).toContain('role="status"');
      expect(html).toContain('A known reason');
      expect(html).toContain('Why there is nothing to show.');
      expect(html).not.toContain('Retry');
      expect(html).not.toContain('<svg');
    }
  });

  it('leaves the fetch-failed default with its warning icon and Retry', () => {
    const html = renderToStaticMarkup(createElement(WidgetUnavailable, { onRetry: () => undefined }));
    expect(html).toContain('Retry');
    expect(html).toContain('<svg');
    expect(html).not.toContain('role="status"');
  });
});

describe.each([
  ['the posture ring', ring, '239/240'],
  ['the posture Stat Card', card, '239 of 240'],
])('%s', (_name, render, live) => {
  it('shows the delta in points against the baseline date, as -1 pt and never flat', () => {
    const html = render(withBaseline);
    expect(html).toContain('-1 pt vs 2026-10-01');
    expect(html).not.toContain('flat');
  });

  it('keeps the live number and names both dates when no category comparison exists', () => {
    const html = render(withGap);
    expect(html).toContain(live);
    expect(html).toContain('role="status"');
    expect(html).toContain('No comparable count on 2026-10-31');
    expect(html).toContain('The earliest date every category can be compared from is 2026-11-03.');
    expect(html).not.toContain('Retry');
  });

  it('says where counts at a subscription level start', () => {
    expect(render(subscriptionGap)).toContain('Counts at this level start on 2026-11-03.');
  });

  it('shows the trend-unavailable message, not a missing-baseline one, when the person is served no level', () => {
    const html = render(noLevel);
    const { title, detail } = trendUnavailableMessage('no-whole-subscription');
    expect(html).toContain(live);
    expect(html).toContain(title);
    expect(html).toContain(detail.replace(/'/g, '&#x27;'));
    expect(html).not.toContain('No comparable count');
  });

  it('shows no delta slot when the filters carry no trend', () => {
    const html = render(summaryWith({ trendIsCategoryScopedOnly: true }));
    expect(html).toContain(live);
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain(' vs ');
  });
});
