/**
 * Scan Coverage's incomplete-rule badge: a sibling link beside the row's Results link, never nested in it,
 * a warn soft fill with no border and no hover title, that opens the Rules tab, and the definition under
 * the list, which says what Last scanned means for the viewer. Rendered on the server, in the style of
 * posture-delta-render.test.ts.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WidgetSummary } from '@/lib/dashboard-data';
import { CoverageFreshnessWidget } from '@/components/dashboard/widgets/coverage-freshness-widget';

let summary: WidgetSummary | null = null;

vi.mock('@/lib/hooks/use-widget-fetch', () => ({
  useWidgetFetch: () => ({ data: summary, loading: false, failed: false, retry: () => undefined }),
}));

const category = (incompleteRuleCount: number) => ({
  category: 'security', label: 'Security', pct: 90, activeFindings: 0, passing: 9, total: 10, lastScanAt: null,
  incompleteRuleCount,
});

const render = (incompleteRuleCount: number, holdsEverything: boolean) => {
  summary = { perCategory: [category(incompleteRuleCount)], holdsEverything } as unknown as WidgetSummary;
  return renderToStaticMarkup(createElement(CoverageFreshnessWidget, { config: {}, filters: { dateWindow: { mode: 'relative', days: 7 } }, refreshKey: 0 }));
};

/** The anchor whose text is `text`, as its opening tag and its text. */
function anchorWith(html: string, text: string): { tag: string; outerHtml: string } | undefined {
  for (const match of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)) {
    if (match[1]!.includes(text)) return { tag: match[0].slice(0, match[0].indexOf('>') + 1), outerHtml: match[0] };
  }
  return undefined;
}

describe('the incomplete-rule badge', () => {
  it('reads "1 rule incomplete" and "N rules incomplete"', () => {
    expect(render(1, true)).toContain('>1 rule incomplete<');
    expect(render(3, true)).toContain('>3 rules incomplete<');
  });

  it('is absent when no rule is incomplete', () => {
    expect(render(0, true)).not.toContain('incomplete<');
  });

  it('is its own link beside the Results link, a warn soft fill with no border and no title', () => {
    const badge = anchorWith(render(2, true), '2 rules incomplete')!;
    expect(badge).toBeDefined();
    expect(badge.tag).toContain('bg-status-warn-soft');
    expect(badge.tag).not.toMatch(/\bborder/);
    expect(badge.tag).not.toContain('title=');
    expect(badge.outerHtml.match(/<a\b/g)).toHaveLength(1);
    const html = render(2, true);
    expect(html.match(/<a\b/g)).toHaveLength(2);
    expect(html.indexOf(badge.outerHtml)).toBeGreaterThan(html.indexOf('</a>'));
  });

  it('opens the Rules tab on the category, enabled and unfinished, with reach only for someone without Everything', () => {
    const everything = new URL(/href="([^"]+)"/.exec(anchorWith(render(2, true), '2 rules')!.tag)![1]!.replaceAll('&amp;', '&'), 'http://localhost');
    expect(everything.searchParams.get('tab')).toBe('rules');
    expect(everything.searchParams.get('lastRun')).toBe('failed|capped|invalid');
    expect(everything.searchParams.get('reach')).toBeNull();
    const scoped = new URL(/href="([^"]+)"/.exec(anchorWith(render(2, false), '2 rules')!.tag)![1]!.replaceAll('&amp;', '&'), 'http://localhost');
    expect(scoped.searchParams.get('reach')).toBe('yours');
  });
});

describe('the row layout', () => {
  /** Everything between the Results link's closing tag and the row's end, up to the next row. */
  const slotAfterResults = (html: string) => /<\/a>(<div class="[^"]*")/.exec(html)?.[1];

  it('reserves the same fixed-width slot for the badge on rows with and without one', () => {
    const withBadge = slotAfterResults(render(2, true));
    const without = slotAfterResults(render(0, true));
    expect(withBadge).toMatch(/\bw-\d+/);
    expect(without).toBe(withBadge);
    expect(render(0, true)).not.toContain('incomplete<');
  });
});

describe('the definitions under the list', () => {
  it('says what Last scanned means for Everything and for anyone else', () => {
    expect(render(0, true)).toContain('newest scan of this category, whatever it covered');
    expect(render(0, false)).toContain('newest scan that covered part of what you hold');
  });
});
