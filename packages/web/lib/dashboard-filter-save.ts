import type { DateWindow } from '@/lib/date-window';
import { isOwnItem } from '@/lib/item-access-model';
import type { DashboardConfig, HeldBackDashboard } from '@/lib/types';

/** What a Shared dashboard says in place of saving: its filters are everyone's, so a change is for this page only. */
export const SHARED_FILTERS_NOTE = 'Filter changes on a Shared dashboard are not saved. They apply to your page only. Stored filters change through Save in edit mode.';

/**
 * Whether a change to the filter bar is saved as it is made (ADR 0012). Only the owner's own Personal dashboard
 * is: nobody else's filter exploring changes what everyone opens, the owner of a Shared dashboard included.
 */
export function autoSavesFilters(actor: { id: string }, dashboard: Pick<HeldBackDashboard, 'owner' | 'visibility'>): boolean {
  return dashboard.visibility === 'personal' && isOwnItem(actor, dashboard);
}

/** The config a save in edit mode sends. A Shared dashboard stores its filter bar only here, so it goes along. */
export function configForSave(
  dashboard: Pick<HeldBackDashboard, 'config' | 'visibility'>,
  changes: { widgets: DashboardConfig['widgets']; autoRefresh: number; filters: DashboardConfig['filters']; dateWindow: DateWindow },
): DashboardConfig {
  const config = { ...dashboard.config, autoRefresh: changes.autoRefresh, widgets: changes.widgets };
  return dashboard.visibility === 'shared'
    ? { ...config, filters: changes.filters, dateWindow: changes.dateWindow, windowDays: undefined }
    : config;
}

export type FilterAutoSaveOutcome =
  /** Nothing was sent: the dashboard does not save filter changes. */
  | { kind: 'not-saved' }
  | { kind: 'saved'; dashboard: HeldBackDashboard }
  /** 409: the dashboard changed after this copy was read. The page shows a reload notice. */
  | { kind: 'stale'; message: string }
  /** 400: a value the person cannot see. It shows in the filter bar, and the filter still applies to the page. */
  | { kind: 'refused'; message: string }
  | { kind: 'failed'; message: string };

const FAILED = 'Failed to save the filters.';

/**
 * Saves the filter bar of a dashboard after a change, when the dashboard is one that saves them. It is built from
 * `dashboard.config` (the last copy the server sent), never from unsaved layout edits, and carries that copy's
 * revision so a dashboard someone else has changed is refused instead of overwritten.
 */
export async function autoSaveFilters(
  actor: { id: string },
  dashboard: HeldBackDashboard,
  filters: NonNullable<DashboardConfig['filters']>,
  dateWindow: DateWindow,
  fetchImpl: typeof fetch = fetch,
): Promise<FilterAutoSaveOutcome> {
  if (!autoSavesFilters(actor, dashboard)) return { kind: 'not-saved' };
  try {
    const res = await fetchImpl(`/api/dashboards/${encodeURIComponent(dashboard.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: { ...dashboard.config, filters, dateWindow, windowDays: undefined },
        revision: dashboard.revision,
        opened: dashboard.config,
      }),
    });
    if (res.redirected) return { kind: 'failed', message: FAILED };
    if (res.ok) return { kind: 'saved', dashboard: await res.json() as HeldBackDashboard };
    const body = await res.json().catch(() => null) as { error?: unknown } | null;
    const message = typeof body?.error === 'string' && body.error.trim() !== '' ? body.error : FAILED;
    if (res.status === 409) return { kind: 'stale', message };
    if (res.status === 400) return { kind: 'refused', message };
    return { kind: 'failed', message: FAILED };
  } catch {
    return { kind: 'failed', message: FAILED };
  }
}
