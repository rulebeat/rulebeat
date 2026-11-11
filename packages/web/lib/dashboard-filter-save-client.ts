/**
 * The page's side of "Save as this dashboard's filters" (ADR 0013): the request, and what each answer
 * means to the person. Client-safe. The server decides; this only reads its answer.
 */
import type { DashboardBarState } from './dashboard-bar';
import type { DashboardFilterChanges } from './finding-view';
import type { Dashboard } from './types';
import { UNAVAILABLE_NOTICE } from './dashboard-conflict';

export type SaveOutcome =
  /** Written. The page adopts the new revision, the bar and the dashboard as the server returned them. */
  | { kind: 'saved'; revision: number; bar: DashboardBarState; dashboard: Dashboard }
  /** Not written, and nothing changed. `outside` is how many values outside the person's Access to remove, when that is the reason. */
  | { kind: 'refused'; message: string; outside?: number }
  /** Someone saved first. Nothing was written, and the changes stay in the address. */
  | { kind: 'conflict'; revision: number; message: string; bar?: DashboardBarState; changedBy?: string; changedAt?: string }
  /** The dashboard was deleted, unshared or handed over: it answers like one that never existed. */
  | { kind: 'gone'; message: string }
  /** The person no longer holds the right to edit. `message` is the reason the save is off. */
  | { kind: 'forbidden'; message: string }
  | { kind: 'failed'; message: string };

const UNSAVED = 'The filters could not be saved. Your changes are still in the address.';

export async function sendFiltersSave(
  dashboardId: string,
  revision: number,
  changes: DashboardFilterChanges,
  fetchImpl: typeof fetch = fetch,
): Promise<SaveOutcome> {
  try {
    const res = await fetchImpl(`/api/dashboards/${dashboardId}/filters`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision, changes }),
    });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    const message = typeof body['error'] === 'string' ? body['error'] : UNSAVED;
    if (res.ok) {
      return { kind: 'saved', revision: body['revision'] as number, bar: body['bar'] as DashboardBarState, dashboard: body['dashboard'] as Dashboard };
    }
    if (res.status === 409) {
      return {
        kind: 'conflict', revision: body['revision'] as number, message,
        ...(typeof body['bar'] === 'object' && body['bar'] !== null && { bar: body['bar'] as DashboardBarState }),
        ...(typeof body['changedBy'] === 'string' && { changedBy: body['changedBy'] }),
        ...(typeof body['changedAt'] === 'string' && { changedAt: body['changedAt'] }),
      };
    }
    if (res.status === 404) return { kind: 'gone', message: UNAVAILABLE_NOTICE };
    if (res.status === 403 && typeof body['reason'] === 'string') return { kind: 'forbidden', message: body['reason'] };
    if (res.status === 422) {
      return body['code'] === 'outside-access' && typeof body['count'] === 'number'
        ? { kind: 'refused', message, outside: body['count'] }
        : { kind: 'refused', message };
    }
    return { kind: 'failed', message };
  } catch {
    return { kind: 'failed', message: UNSAVED };
  }
}
