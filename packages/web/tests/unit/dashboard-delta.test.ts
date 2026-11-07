import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { Delta } from '@/components/dashboard/widgets/delta';
import { sinceLabel } from '@/lib/date-window';

const render = (props: Parameters<typeof Delta>[0]) => renderToStaticMarkup(createElement(Delta, props));
const text = (html: string) => html.replace(/<[^>]*>/g, '');

describe('sinceLabel', () => {
  it('counts whole days back from today', () => {
    expect(sinceLabel('2026-02-05', '2026-03-07')).toBe('since 30 days ago');
  });
  it('uses plain words for yesterday and today', () => {
    expect(sinceLabel('2026-03-06', '2026-03-07')).toBe('since yesterday');
    expect(sinceLabel('2026-03-07', '2026-03-07')).toBe('since today');
  });
});

describe('Delta', () => {
  it('reads a rise as a signed number, an up arrow and words, in ink', () => {
    const html = render({ value: 12, suffix: '%', since: 'since 30 days ago' });
    expect(text(html)).toBe('+12% since 30 days ago');
    expect(html).toContain('lucide-arrow-up');
    expect(html).toContain('text-ink');
  });

  it('reads a fall with a minus sign and a down arrow, also in ink', () => {
    const html = render({ value: -5, suffix: '%', since: 'since 7 days ago' });
    expect(text(html)).toBe('-5% since 7 days ago');
    expect(html).toContain('lucide-arrow-down');
    expect(html).toContain('text-ink');
  });

  it('says there is no change rather than printing 0', () => {
    const html = render({ value: 0, suffix: '%', since: 'since 7 days ago' });
    expect(text(html)).toBe('No change since 7 days ago');
    expect(html).toContain('lucide-arrow-right');
  });

  it('never uses the ok status colour or a severity colour, whichever way it moves', () => {
    for (const value of [12, -12, 0]) {
      const html = render({ value, since: 'since today' });
      expect(html).not.toMatch(/status-ok|sev-|text-red|text-green/);
    }
  });

  it('renders nothing without a value', () => {
    expect(render({ value: null })).toBe('');
  });
});
