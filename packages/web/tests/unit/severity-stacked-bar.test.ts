import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { SeverityStackedBar, segmentFits, type SeveritySegment } from '@/components/dashboard/severity-stacked-bar';

const segments: SeveritySegment[] = [
  { severity: 'critical', label: 'Critical', value: 12, href: '/scans?severity=critical', color: 'var(--color-sev-critical)' },
  { severity: 'high', label: 'High', value: 30, href: '/scans?severity=high', color: 'var(--color-sev-high)' },
  { severity: 'info', label: 'Info', value: 1, href: '/scans?severity=info', color: 'var(--color-ink-faint)' },
];
const render = (width?: number) => renderToStaticMarkup(createElement(SeverityStackedBar, { segments, width }));

describe('segmentFits', () => {
  it('fits a number when the segment is wide enough at 12px and not when it is a sliver', () => {
    expect(segmentFits(30, 43, 400)).toBe(true);
    expect(segmentFits(1, 43, 400)).toBe(false);
  });
  it('needs more room for more digits', () => {
    expect(segmentFits(100, 1000, 120)).toBe(false);
    expect(segmentFits(10, 100, 120)).toBe(false);
    expect(segmentFits(50, 100, 120)).toBe(true);
    expect(segmentFits(5, 10, 40)).toBe(true);
    expect(segmentFits(500, 1000, 40)).toBe(false);
  });
  it('fits nothing before the width is known', () => {
    expect(segmentFits(30, 43, 0)).toBe(false);
  });
});

describe('SeverityStackedBar', () => {
  it('draws one 24px bar with a segment per severity in the order given', () => {
    const html = render(400);
    expect(html).toContain('h-6');
    const order = [...html.matchAll(/data-severity="(\w+)"/g)].map(m => m[1]);
    expect(order).toEqual(['critical', 'high', 'info']);
    expect(html).toContain('var(--color-ink-faint)');
  });

  it('gives each severity a legend entry whose count is a real anchor', () => {
    const html = render(400);
    for (const s of segments) {
      expect(html).toContain(`<a`);
      expect(html).toMatch(new RegExp(`<a[^>]*href="${s.href.replace(/[?]/g, '\\?')}"[^>]*>[^]*?${s.label}[^]*?${s.value}`));
    }
    expect(html.match(/<a /g)).toHaveLength(3);
  });

  it('prints a number inside a wide segment only, leaving the narrow one to the legend', () => {
    const html = render(400);
    const inside = [...html.matchAll(/data-severity="(\w+)"[^>]*>([^<]*)</g)].map(m => [m[1], m[2]]);
    expect(inside).toEqual([['critical', '12'], ['high', '30'], ['info', '']]);
  });

  it('prints no number inside any segment before the width is known', () => {
    const html = render(undefined);
    expect([...html.matchAll(/data-severity="\w+"[^>]*>([^<]*)</g)].map(m => m[1])).toEqual(['', '', '']);
  });
});
