/**
 * Held-back values (#363): the chip that stands where stored values outside the viewer's Access would be.
 * Rendered on the server, in the style of scoped-access-render.test.ts.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HeldBackChip } from '@/components/ui/held-back-chip';
import { FilterChips } from '@/components/findings/add-filter';
import { OUTSIDE_ACCESS_LABEL } from '@/lib/held-back';

const chip = (count: number, visible: number) => renderToStaticMarkup(createElement(HeldBackChip, { count, visible }));

describe('the held-back chip', () => {
  it('reads "N outside your access" beside visible values', () => {
    expect(chip(2, 1)).toContain('>2 outside your access<');
  });

  it('reads only "Outside your access" when every value is held back', () => {
    const html = chip(3, 0);
    expect(html).toContain(`>${OUTSIDE_ACCESS_LABEL}<`);
    expect(html).not.toContain('3 outside');
  });

  it('is a soft fill with no border, no remove control, 12px text and not label-grid', () => {
    const html = chip(1, 1);
    expect(html).toContain('bg-surface-sunken');
    expect(html).toContain('text-xs');
    expect(html).not.toMatch(/\bborder\b/);
    expect(html).not.toContain('label-grid');
    expect(html).not.toContain('<button');
  });
});

describe('the Scans filter chips', () => {
  const render = (held: Parameters<typeof FilterChips>[0]['held']) =>
    renderToStaticMarkup(createElement(FilterChips, { chips: [], held, onRemove: () => undefined }));

  it('shows one count chip per held-back dimension, named by the field and with no remove control', () => {
    const html = render([{ dimension: 'subscription', fieldLabel: 'Subscription', count: 2, visible: 0 }]);
    expect(html).toContain('Subscription');
    expect(html).toContain(`>${OUTSIDE_ACCESS_LABEL}<`);
    expect(html).not.toContain('<button');
  });

  it('renders nothing when there is no filter and nothing held back', () => {
    expect(render([])).toBe('');
  });
});
