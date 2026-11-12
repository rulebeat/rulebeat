import type { DateWindow } from '@/lib/date-window';
import { STALE_DASHBOARD_MESSAGE } from '@/lib/held-back';
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

/**
 * The config a save sends. A Shared dashboard stores its filter bar only through Save in edit mode, which passes
 * `filters` and `dateWindow`. Any other save (the auto-refresh selector) leaves them out, so the stored filter bar
 * goes back as it is and whatever the person explored on their page is not stored for everyone.
 */
export function configForSave(
  dashboard: Pick<HeldBackDashboard, 'config' | 'visibility'>,
  changes: { widgets: DashboardConfig['widgets']; autoRefresh: number; filters?: DashboardConfig['filters']; dateWindow?: DateWindow },
): DashboardConfig {
  const config = { ...dashboard.config, autoRefresh: changes.autoRefresh, widgets: changes.widgets };
  return dashboard.visibility === 'shared' && changes.filters !== undefined && changes.dateWindow !== undefined
    ? { ...config, filters: changes.filters, dateWindow: changes.dateWindow, windowDays: undefined }
    : config;
}

/**
 * The filter bar a save carries: the page's filters when the save is the Save of edit mode, and nothing for any other
 * save ("Save changes" after a widget Configure, or after an edit-mode Save that failed). What a person explored on
 * their own page is then not stored for everyone.
 */
export function filterBarForSave(
  inEditMode: boolean, filters: NonNullable<DashboardConfig['filters']>, dateWindow: DateWindow,
): { filters?: NonNullable<DashboardConfig['filters']>; dateWindow?: DateWindow } {
  return inEditMode ? { filters, dateWindow } : {};
}

/** A rename names the revision of the copy the page holds, so a rename from a copy that has moved on is refused. */
export function renameBody(dashboard: Pick<HeldBackDashboard, 'revision'>, name: string): { name: string; revision: number } {
  return { name, revision: dashboard.revision };
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

export type DashboardSaveOutcome =
  | { kind: 'saved'; dashboard: HeldBackDashboard }
  /** 409 on a stale base: the dashboard changed after this copy was read. The page shows the reload notice. */
  | { kind: 'stale'; message: string }
  | { kind: 'failed'; message: string };

/**
 * The Save of edit mode. It carries the revision and the copy it was sent. Only the stale-base 409 is the reload
 * notice: the same status also answers a name already in use, which is an error the person can fix without
 * losing their edits.
 */
export async function saveDashboardEdits(
  dashboard: Pick<HeldBackDashboard, 'id' | 'revision' | 'config'>,
  changes: { name: string; config: DashboardConfig },
  fetchImpl: typeof fetch = fetch,
): Promise<DashboardSaveOutcome> {
  const FAILED_SAVE = 'Failed to save the dashboard.';
  try {
    const res = await fetchImpl(`/api/dashboards/${encodeURIComponent(dashboard.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...changes, revision: dashboard.revision, opened: dashboard.config }),
    });
    if (res.ok) return { kind: 'saved', dashboard: await res.json() as HeldBackDashboard };
    const body = await res.json().catch(() => ({})) as { error?: string };
    if (res.status === 409 && body.error === STALE_DASHBOARD_MESSAGE) return { kind: 'stale', message: STALE_DASHBOARD_MESSAGE };
    return { kind: 'failed', message: body.error ?? FAILED_SAVE };
  } catch {
    return { kind: 'failed', message: FAILED_SAVE };
  }
}

/**
 * The writes one page makes to its own dashboard. Each write is built from the latest copy this page holds, not
 * the copy that was current when the write was planned, and runs only after the writes before it have answered.
 * Without that, a person's own earlier write moves the revision first and their next one is refused as stale:
 * a filter change followed within the debounce by an auto-refresh change, or a second filter change while the
 * first save is still in flight.
 */
export class DashboardWrites {
  private latest: HeldBackDashboard;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(initial: HeldBackDashboard) {
    this.latest = initial;
  }

  /** The latest copy this page holds. */
  get current(): HeldBackDashboard {
    return this.latest;
  }

  /** Takes a copy the page learned about elsewhere (a share, a hand-over) as the base of the next write. */
  adopt(dashboard: HeldBackDashboard): void {
    this.latest = dashboard;
  }

  /** Runs `write` after every write queued before it, handing it the latest copy. A saved answer becomes the latest copy. */
  run<T extends { kind: string }>(write: (latest: HeldBackDashboard) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const outcome = await write(this.latest);
      if (outcome.kind === 'saved' && 'dashboard' in outcome) this.latest = outcome.dashboard as HeldBackDashboard;
      return outcome;
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}
