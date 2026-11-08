/**
 * The funnel on a widget title names the dimensions the widget sets itself, so a person who changes
 * the filter bar knows why that widget did not follow.
 */
import { createElement, type ComponentProps } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WidgetWrapper } from '@/components/dashboard/widget-wrapper';
import { widgetOverriddenDimensions, widgetScopeNote } from '@/lib/dashboard-filters';
import type { WidgetDef } from '@/lib/types';

describe('the dimensions a widget overrides', () => {
  it('are the ones its config sets, named as the filter bar names them', () => {
    expect(widgetOverriddenDimensions({ severities: ['high'], tags: ['prod'], policyIds: ['r1'], windowDays: 7 }))
      .toEqual(['Rule', 'Tags', 'Severity', 'Window']);
    expect(widgetOverriddenDimensions({ category: 'security', subscriptions: ['s'], resourceGroups: ['rg'] }))
      .toEqual(['Category', 'Subscription', 'Resource group']);
  });

  it('leave out a config that inherits: category "all", empty lists, a window that is not a preset', () => {
    expect(widgetOverriddenDimensions({ category: 'all', severities: [], tags: [], windowDays: 14, limit: 5 })).toEqual([]);
  });
});

describe('the funnel tooltip', () => {
  it('names the overridden dimensions', () => {
    expect(widgetScopeNote({ severities: ['high'] }, false)).toBe('This widget uses its own Severity.');
    expect(widgetScopeNote({ severities: ['high'], tags: ['prod'], windowDays: 30 }, false))
      .toBe('This widget uses its own Tags, Severity and Window.');
  });

  it('says the dashboard\'s filters apply to the rest while the bar has any', () => {
    expect(widgetScopeNote({ severities: ['high'] }, true)).toBe('This widget uses its own Severity. The dashboard\'s filters apply to the rest.');
  });

  it('says the dashboard\'s filters scope a widget that overrides nothing', () => {
    expect(widgetScopeNote({}, true)).toBe('Scoped by the dashboard\'s filters');
  });

  it('is what the widget title shows', () => {
    const widget = { id: 'w', type: 'stat-card', title: 'Open findings', x: 0, y: 0, w: 4, h: 4, config: { severities: ['high'] } } as WidgetDef;
    const props: ComponentProps<typeof WidgetWrapper> = {
      widget, editMode: false, filtered: true, scopeNote: widgetScopeNote(widget.config, false), children: null,
    };
    const html = renderToString(createElement(WidgetWrapper, props));
    expect(html).toContain('This widget uses its own Severity.');
    expect(html).not.toContain('Scoped by dashboard or widget filters');
  });
});
