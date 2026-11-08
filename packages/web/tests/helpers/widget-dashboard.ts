import { createDashboard } from '@/lib/db/dashboards';
import type { WidgetDef } from '@/lib/types';

/** A dashboard with one widget, `w`, that sets no override and no limit. Returns the query that names it. */
export async function widgetDashboardQuery(config: Record<string, unknown> = {}): Promise<string> {
  const widget = { id: 'w', type: 'stat-card', title: 'w', x: 0, y: 0, w: 4, h: 4, config } as WidgetDef;
  const created = await createDashboard({ name: `widget routes ${crypto.randomUUID()}`, config: { widgets: [widget] } });
  if (!created.ok) throw new Error(created.reason);
  return `dashboard=${created.dashboard.id}&widget=w`;
}
