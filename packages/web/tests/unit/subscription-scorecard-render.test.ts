/**
 * The Subscription scorecard's tiles: "All passing" only when every counted rule passes, "N not yet proven"
 * otherwise, the reason a total of 0 gives (subscription and Directory), the part-held label, the empty
 * state, the order (lowest unrounded ratio first, then more findings, then name, uncovered last), the
 * "Showing N of M" line when the limit cuts the list, the footer, and the notes handed to the frame.
 * Rendered on the server with the widget fetch replaced by the summary a response would hold.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WidgetSummary } from '@/lib/dashboard-data';
import { SubscriptionScorecardWidget } from '@/components/dashboard/widgets/subscription-scorecard-widget';
import type { SubscriptionRow } from '@/lib/subscription-rows';
import { WIDGET_LIMITS } from '@/lib/widget-limits';

let summary: WidgetSummary | null = null;
let reported: string[] | undefined;

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }));
vi.mock('@/lib/hooks/use-subscription-names', () => ({ useSubscriptionNames: () => ({}) }));
vi.mock('@/lib/hooks/use-widget-fetch', () => ({
  useWidgetFetch: () => ({ data: summary, loading: false, failed: false, retry: () => undefined }),
}));
vi.mock('@/lib/hooks/use-widget-notes', () => ({
  useReportWidgetNotes: (notes: string[]) => { reported = notes; },
}));

const row = (name: string, over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  subscriptionId: `id-${name}`, name, directory: false, passingRules: 2, totalRules: 2, unknownRules: 0, pct: 100, activeFindings: 0,
  yourGroupsOnly: false, ...over,
});
const directoryRow = (over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  ...row('Directory', { subscriptionId: 'directory', name: null }), directory: true, ...over,
});

const render = (rows: SubscriptionRow[], extra: Partial<WidgetSummary> = {}, config: { limit?: number } = {}) => {
  summary = { perSubscription: rows, subscriptionNotes: [WIDGET_LIMITS.w2], outsideSubscriptions: null, ...extra } as unknown as WidgetSummary;
  return renderToStaticMarkup(createElement(SubscriptionScorecardWidget, { config, filters: { dateWindow: { mode: 'relative', days: 7 } }, refreshKey: 0 }));
};

/** The tiles in the order they are listed, each as its text. */
const tiles = (html: string): string[] => [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map(m => m[1]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

beforeEach(() => { reported = undefined; });

describe('a tile', () => {
  it('reads "All passing" when every counted rule passes', () => {
    const [tile] = tiles(render([row('Alpha')]));
    expect(tile).toContain('2/2');
    expect(tile).toContain('All passing');
    expect(tile).not.toContain('not yet proven');
  });

  it('reads how many rules are not yet proven, and not "All passing", when one has not run', () => {
    const [tile] = tiles(render([row('Alpha', { passingRules: 1, unknownRules: 1, pct: 50 })]));
    expect(tile).toContain('1/2');
    expect(tile).toContain('1 not yet proven');
    expect(tile).not.toContain('All passing');
  });

  it('is never "All passing" with a failing rule, and counts its findings', () => {
    const [tile] = tiles(render([row('Alpha', { passingRules: 1, pct: 50, activeFindings: 3 })]));
    expect(tile).toContain('3 findings');
    expect(tile).not.toContain('All passing');
  });

  it('still shows the findings placed in a row whose counted rules all pass', () => {
    const [tile] = tiles(render([row('Alpha', { activeFindings: 2 })]));
    expect(tile).toContain('All passing');
    expect(tile).toContain('2 findings');
  });

  it('says no rules cover a subscription whose total is 0, with no ratio and no "All passing"', () => {
    const [tile] = tiles(render([row('Delta', { passingRules: 0, totalRules: 0, pct: null })]));
    expect(tile).toContain('No rules cover this subscription');
    expect(tile).not.toContain('All passing');
    expect(tile).not.toContain('0/0');
  });

  it('says no rules cover the Directory when the Directory\'s total is 0', () => {
    const [tile] = tiles(render([directoryRow({ passingRules: 0, totalRules: 0, pct: null })]));
    expect(tile).toContain('Directory');
    expect(tile).toContain('No rules cover the Directory');
    expect(tile).not.toContain('No rules cover this subscription');
  });

  it('grades the Directory like a subscription when a Graph rule covers it', () => {
    const [tile] = tiles(render([directoryRow({ passingRules: 1, totalRules: 2, unknownRules: 1, pct: 50 })]));
    expect(tile).toContain('1/2');
    expect(tile).toContain('1 not yet proven');
  });

  it('names a part-held subscription as counted over the resource groups held', () => {
    expect(tiles(render([row('Alpha', { yourGroupsOnly: true })]))[0]).toContain('Your resource groups only');
    expect(tiles(render([row('Alpha')]))[0]).not.toContain('Your resource groups only');
  });

  it('is named by the tree\'s name, else the id', () => {
    const html = render([row('Alpha'), row('x', { subscriptionId: 'bare-id', name: null })]);
    expect(tiles(html).join('|')).toContain('Alpha');
    expect(tiles(html).join('|')).toContain('bare-id');
  });

  it('no longer carries the per-category total caption', () => {
    const html = render([row('Alpha')]);
    expect(html).not.toContain('Total is per category');
    expect(html).not.toContain('Totals are per category');
  });
});

describe('the empty state', () => {
  it('says why there is no row', () => {
    const html = render([]);
    expect(html).toContain('No subscriptions known yet. RuleBeat lists them once it has read the management group tree or found a finding.');
    expect(tiles(html)).toEqual([]);
  });
});

describe('the order', () => {
  it('lists the lowest unrounded ratio first, then more findings, then name, with rows no rule covers last', () => {
    const rows = [
      row('Zulu', { passingRules: 239, totalRules: 240, pct: 99 }),
      row('Uncovered', { passingRules: 0, totalRules: 0, pct: null, activeFindings: 9 }),
      row('Bravo', { passingRules: 1, totalRules: 2, pct: 50, activeFindings: 1 }),
      row('Alpha', { passingRules: 1, totalRules: 2, pct: 50, activeFindings: 1 }),
      row('Charlie', { passingRules: 1, totalRules: 2, pct: 50, activeFindings: 4 }),
      row('Echo', { passingRules: 1, totalRules: 3, pct: 33, activeFindings: 0 }),
      row('Full', { passingRules: 2, totalRules: 2, pct: 100 }),
    ];
    const order = tiles(render(rows)).map(t => t.split(' ')[0]);
    expect(order).toEqual(['Echo', 'Charlie', 'Alpha', 'Bravo', 'Zulu', 'Full', 'Uncovered']);
  });

  it('puts 239 of 240 before 100%, though both could be told apart only by the unrounded ratio', () => {
    const order = tiles(render([row('Full'), row('Almost', { passingRules: 239, totalRules: 240, pct: 99 })])).map(t => t.split(' ')[0]);
    expect(order).toEqual(['Almost', 'Full']);
  });
});

describe('the limit', () => {
  const many = ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((n, i) => row(n, { passingRules: i, totalRules: 4, pct: i * 25 }));

  it('cuts to the lowest rows and says how many of how many are shown', () => {
    const html = render(many, {}, { limit: 2 });
    expect(tiles(html).map(t => t.split(' ')[0])).toEqual(['Alpha', 'Bravo']);
    expect(html).toContain('Showing 2 of 4, lowest first');
  });

  it('says nothing when the limit cuts nothing', () => {
    expect(render(many, {}, { limit: 4 })).not.toContain('Showing');
    expect(render(many)).not.toContain('Showing');
  });
});

describe('the footer', () => {
  it('counts the findings placed outside any subscription or the Directory, and opens them on Scans', () => {
    const html = render([row('Alpha')], { outsideSubscriptions: 3 });
    expect(html).toContain('3 findings sit outside any subscription or the Directory');
    const href = /<a [^>]*href="([^"]+)"[^>]*>3 findings sit/.exec(html)![1]!.replaceAll('&amp;', '&');
    const url = new URL(href, 'http://localhost');
    expect(url.pathname).toBe('/scans');
    expect(url.searchParams.get('status')).toBe('open');
    expect(url.searchParams.getAll('f')).toEqual(['placement=management-group|unplaceable']);
  });

  it('reads in the singular for one finding', () => {
    expect(render([row('Alpha')], { outsideSubscriptions: 1 })).toContain('1 finding sits outside any subscription or the Directory');
  });

  it('is hidden when the server sends none, as under a subscription, resource group or Directory filter', () => {
    expect(render([row('Alpha')], { outsideSubscriptions: null })).not.toContain('sit outside');
  });
});

describe('the notes', () => {
  it('hands the notes the server sent to the widget frame', () => {
    render([row('Alpha')], { subscriptionNotes: [WIDGET_LIMITS.w2, WIDGET_LIMITS.w3] });
    expect(reported).toEqual([WIDGET_LIMITS.w2, WIDGET_LIMITS.w3]);
  });
});
