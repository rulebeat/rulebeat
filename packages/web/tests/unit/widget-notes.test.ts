/**
 * The notes slot: a widget's limit notes sit inside its body, after its content, always visible, in
 * the quiet caption style and without a border. The server decides which notes apply; the wrapper
 * only draws the list it is given.
 */
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WidgetWrapper } from '@/components/dashboard/widget-wrapper';
import type { WidgetDef } from '@/lib/types';

const widget = { id: 'w1', type: 'posture-ring', title: 'Overall posture', config: {}, x: 0, y: 0, w: 3, h: 4 } as unknown as WidgetDef;

const render = (notes?: string[]) => renderToStaticMarkup(
  createElement(WidgetWrapper, { widget, editMode: false, notes } as ComponentProps<typeof WidgetWrapper>, createElement('div', { id: 'content' }, 'The figure')),
);

describe('WidgetWrapper notes', () => {
  it('draws each note inside the widget body after its content, in text-xs text-ink-muted, with no border', () => {
    const html = render(['First limit.', 'Second limit.']);
    const body = html.slice(html.indexOf('data-widget-body'));
    expect(body.indexOf('The figure')).toBeGreaterThan(-1);
    expect(body.indexOf('First limit.')).toBeGreaterThan(body.indexOf('The figure'));
    expect(body.indexOf('Second limit.')).toBeGreaterThan(body.indexOf('First limit.'));

    const note = html.match(/<p[^>]*>First limit\.<\/p>/)![0];
    expect(note).toContain('text-xs');
    expect(note).toContain('text-ink-muted');
    expect(note).not.toMatch(/border/);
    expect(html.match(/<[^>]*data-widget-notes[^>]*>/)![0]).not.toMatch(/border/);
  });

  it('draws no notes element when there are none, or the list is empty', () => {
    expect(render()).not.toContain('data-widget-notes');
    expect(render([])).not.toContain('data-widget-notes');
  });
});
