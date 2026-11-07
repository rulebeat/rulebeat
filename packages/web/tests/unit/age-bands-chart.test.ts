import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { AgeBandsChart, type AgeBand } from '@/components/dashboard/age-bands-chart';

const bands: AgeBand[] = [
  { key: '0-7', label: '0 to 7 days', count: 10, href: '/scans?age=0-7' },
  { key: '8-30', label: '8 to 30 days', count: 0, href: '/scans?age=8-30' },
  { key: '31-90', label: '31 to 90 days', count: 5, href: '/scans?age=31-90' },
];
const html = renderToStaticMarkup(createElement(AgeBandsChart, { bands }));

describe('AgeBandsChart', () => {
  it('lists the bands in the order given', () => {
    expect([...html.matchAll(/data-band="([^"]+)"/g)].map(m => m[1])).toEqual(['0-7', '8-30', '31-90']);
  });

  it('draws every filled bar in chart-1 and in proportion to the largest band', () => {
    const bars = [...html.matchAll(/data-bar="([^"]+)"[^>]*style="([^"]*)"/g)];
    expect(bars.map(m => m[1])).toEqual(['0-7', '31-90']);
    expect(bars[0]![2]).toContain('width:100%');
    expect(bars[1]![2]).toContain('width:50%');
    for (const m of bars) expect(m[2]).toContain('var(--color-chart-1)');
  });

  it('keeps a track and a linked 0 for an empty band', () => {
    const row = html.slice(html.indexOf('data-band="8-30"'), html.indexOf('data-band="31-90"'));
    expect(row).toContain('bg-track');
    expect(row).not.toContain('data-bar=');
    expect(row).toMatch(/<a[^>]*href="\/scans\?age=8-30"[^>]*>0<\/a>/);
  });

  it('makes each count a real anchor', () => {
    expect(html).toMatch(/<a[^>]*href="\/scans\?age=0-7"[^>]*>10<\/a>/);
    expect(html.match(/<a /g)).toHaveLength(3);
  });

  it('carries the hidden table of values and is not an image', () => {
    expect(html).toContain('<table class="sr-only">');
    expect(html).toContain('<td>10</td>');
    expect(html).not.toContain('role="img"');
  });

  it('heads the hidden table label column with Age, not Date', () => {
    expect(html).toContain('<th scope="col">Age</th>');
    expect(html).not.toContain('>Date<');
  });
});
