/**
 * A new chart widget, and the starter dashboard, seed no `period`: a seeded period is read as the
 * widget's own window, which would fix every new chart at 30 days and hide the dashboard's date window.
 */
import { describe, expect, it } from 'vitest';
import { WIDGET_TEMPLATES } from '@/components/dashboard/add-widget-panel';
import { STARTER_DASHBOARD } from '@/lib/dashboard-templates';
import { mergeWidgetFilters } from '@/lib/dashboard-filters';

const CHARTS = ['trend', 'new-vs-fixed', 'activity-occurrences'] as const;

describe('seeded widget configs', () => {
  it.each(CHARTS)('the Add widget template for %s carries no period', type => {
    const template = WIDGET_TEMPLATES.find(t => t.type === type)!;
    expect(template.defaultConfig).not.toHaveProperty('period');
  });

  it('the starter dashboard carries no period on any widget', () => {
    for (const widget of STARTER_DASHBOARD.config.widgets) expect(widget.config).not.toHaveProperty('period');
  });

  it.each(CHARTS)("a new %s widget follows the dashboard's date window", type => {
    const config = WIDGET_TEMPLATES.find(t => t.type === type)!.defaultConfig;
    const dashboard = { dateWindow: { mode: 'relative' as const, days: 7 } };
    expect(mergeWidgetFilters(dashboard, config).dateWindow).toEqual(dashboard.dateWindow);
  });
});
