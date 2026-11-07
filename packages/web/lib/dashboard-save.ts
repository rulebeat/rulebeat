import type { Dashboard, DashboardConfig, WidgetDef } from './types';
import { snapSpan } from './widget-sizes';

/**
 * What the dashboard client sends to `PUT /api/dashboards/[id]` and how it reads a refusal. Pure, so
 * the contract the route checks (a revision on every save, widths from the size table) is tested
 * without rendering the page.
 */

/** Every width moved to the nearest allowed span (a tie to the smaller), which the PUT accepts. Nothing else changes. */
export function withSnappedWidths(config: DashboardConfig): DashboardConfig {
  return { ...config, widgets: config.widgets.map((w): WidgetDef => ({ ...w, w: snapSpan(w.type, w.w) })) };
}

/**
 * The body of a save: the changed fields, the revision the client read, and the config with its
 * widths snapped. `name` and `config` are left out when not given.
 */
export function saveBody(dashboard: Pick<Dashboard, 'revision'>, change: { name?: string; config?: DashboardConfig }): string {
  return JSON.stringify({
    ...(change.name !== undefined && { name: change.name }),
    ...(change.config !== undefined && { config: withSnappedWidths(change.config) }),
    revision: dashboard.revision,
  });
}

export interface RefusedSave { error?: string; reason?: string; editor?: string | null; at?: string }

/** The sentence a refused save shows: who changed the dashboard and when for a conflict, else the server's own words. */
export function saveFailureMessage(body: RefusedSave, fallback: string): string {
  if (body.reason === 'revision-conflict') {
    const who = body.editor ?? 'Someone who is no longer in RuleBeat';
    const when = body.at && !Number.isNaN(Date.parse(body.at)) ? ` at ${new Date(body.at).toLocaleString()}` : '';
    return `${who} changed this dashboard${when}. Reload the page to see their version before saving again.`;
  }
  return body.error ?? fallback;
}
