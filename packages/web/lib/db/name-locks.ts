/**
 * The Postgres advisory lock keys that serialize the name checks of dashboards and saved views (a no-op on
 * SQLite, whose transaction lock already serializes every writer). A write that touches both takes them in
 * this order, the dashboard key first and the saved view key second, so two transactions can never wait on
 * each other: a dashboard save and share, and a saved view's unshare and delete (ADR 0012).
 */
import { pgAdvisoryXactLock, type DbHandle } from './exec';

export const DASHBOARD_NAME_LOCK_KEY = 7194826034;
export const SAVED_VIEW_NAME_LOCK_KEY = 7194826112;

/** Takes the dashboard name lock, then the saved view name lock. */
export async function lockDashboardsThenViews(tx: DbHandle): Promise<void> {
  await pgAdvisoryXactLock(tx, DASHBOARD_NAME_LOCK_KEY);
  await pgAdvisoryXactLock(tx, SAVED_VIEW_NAME_LOCK_KEY);
}
