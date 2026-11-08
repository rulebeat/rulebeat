'use client';

import { createContext, useContext } from 'react';

/** What a widget needs to ask the server for its numbers (ADR 0013): which dashboard and widget it
 *  is, and the filter changes in force. It never carries assembled filters. */
export interface WidgetRequestScope {
  dashboardId: string;
  widgetId: string;
  /** The widget's type, which a preview needs for a widget that is not saved yet. */
  widgetType?: string;
  /** The filter changes as query params, written by `dashboardAddress`. */
  changes: string;
  /** Set while the widget's config differs from the saved one (edit mode): the draft the server counts instead. */
  preview?: { config: Record<string, unknown> };
}

const WidgetRequestContext = createContext<WidgetRequestScope | null>(null);
export const WidgetRequestProvider = WidgetRequestContext.Provider;

/**
 * The URL of one counting route for the widget it is rendered in. `limit` and `trendDays` travel only
 * in a preview: otherwise the server reads them from the widget's stored config.
 */
export function useWidgetUrl(route: string, settings: { limit?: number; trendDays?: number } = {}): string {
  const scope = useContext(WidgetRequestContext);
  if (!scope) throw new Error('A widget must be rendered inside a WidgetRequestProvider.');
  const params = new URLSearchParams(scope.changes);
  params.set('dashboard', scope.dashboardId);
  params.set('widget', scope.widgetId);
  if (scope.preview) {
    params.set('preview', '1');
    params.set('draft', JSON.stringify(scope.preview.config));
    if (scope.widgetType) params.set('type', scope.widgetType);
    if (settings.limit !== undefined) params.set('limit', String(settings.limit));
    if (settings.trendDays !== undefined) params.set('trendDays', String(settings.trendDays));
  }
  return `/api/widgets/${route}?${params}`;
}
