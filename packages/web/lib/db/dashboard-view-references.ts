/**
 * Which saved views the dashboards use (#376, ADR 0012). A widget names a view in its config as `savedViewId`.
 * A Shared dashboard may use only Shared views; the check runs inside the write that would break it, with the
 * dashboard and saved view name locks held (lib/db/name-locks.ts).
 */
import { eq, inArray } from 'drizzle-orm';
import { db } from './client';
import { dashboards, savedViews } from './tables';
import { many, type DbHandle } from './exec';
import { chunk } from './chunk';
import { readVisibility } from './item-owners';
import { savedViewIdOf } from '@/lib/saved-view-reference';
import type { DashboardConfig } from '@/lib/types';

/**
 * The titles of the widgets in `config` that use a saved view which is not Shared: someone's Personal view
 * (the saver's own or anyone else's, which look alike here) or one that no longer exists. Titles are the
 * dashboard's own, so the answer names no view.
 */
export async function widgetsOnUnsharedViews(handle: DbHandle, config: DashboardConfig): Promise<string[]> {
  const used = (config.widgets ?? []).flatMap(widget => {
    const viewId = savedViewIdOf(widget.config);
    return viewId === null ? [] : [{ widget, viewId }];
  });
  if (used.length === 0) return [];
  const shared = new Set<string>();
  for (const ids of chunk([...new Set(used.map(u => u.viewId))])) {
    for (const row of await many(handle.select({ id: savedViews.id, visibility: savedViews.visibility }).from(savedViews).where(inArray(savedViews.id, ids)))) {
      if (readVisibility(row.visibility) === 'shared') shared.add(row.id);
    }
  }
  return used.filter(u => !shared.has(u.viewId)).map(u => u.widget.title?.trim() || u.widget.type);
}

/** How many Shared dashboards use each of the saved views, by view id. A view none uses is absent. */
export async function sharedDashboardUseCounts(handle: DbHandle = db): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const row of await many(handle.select({ config: dashboards.config }).from(dashboards).where(eq(dashboards.visibility, 'shared')))) {
    let config: DashboardConfig;
    try { config = JSON.parse(row.config) as DashboardConfig; } catch { continue; }
    const ids = new Set((config.widgets ?? []).map(widget => savedViewIdOf(widget.config)).filter((id): id is string => id !== null));
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}
