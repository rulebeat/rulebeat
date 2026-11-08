import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from './client';
import { dashboards, users } from './tables';
import { inTransaction, many, one, pgAdvisoryXactLock, run, type DbHandle } from './exec';
import { chunk } from './chunk';
import { canOpenItem } from '@/lib/item-access-model';
import { readVisibility } from './item-owners';

/** The one advisory lock every write to a dashboard, the Install default or a My default takes first. */
export const DASHBOARD_NAME_LOCK_KEY = 7194826034;

/**
 * My default (ADR 0012): the dashboard a person opens first. It lives on the person's own `users` row
 * with no SQL-level foreign key, so a dashboard going away never has to wait on it. `unavailable` records
 * that the dashboard they chose stopped being reachable for them, until `/dashboard` has said so once.
 */
export interface MyDefault {
  dashboardId: string | null;
  unavailable: boolean;
}

export async function getMyDefault(userId: string): Promise<MyDefault> {
  const row = await one(db.select({ id: users.defaultDashboardId, unavailable: users.defaultDashboardUnavailable })
    .from(users).where(eq(users.id, userId)));
  return { dashboardId: row?.id ?? null, unavailable: row?.unavailable ?? false };
}

export type SetMyDefaultResult = { ok: true } | { ok: false; reason: 'not-found' };

/**
 * Stores `dashboardId` as the person's My default and clears the unavailable flag: their own Personal
 * dashboard or any Shared one. Someone else's Personal dashboard is `not-found`, like an unknown id.
 */
export async function setMyDefault(userId: string, dashboardId: string): Promise<SetMyDefaultResult> {
  return inTransaction(async (tx) => {
    // The lock an unshare or a delete takes before it clears the My defaults it strands: without it, on
    // Postgres, that clearing can read `users` before this choice commits and miss it.
    await pgAdvisoryXactLock(tx, DASHBOARD_NAME_LOCK_KEY);
    const target = await one(tx.select({ ownerId: dashboards.ownerId, visibility: dashboards.visibility })
      .from(dashboards).where(eq(dashboards.id, dashboardId)));
    if (!target || !canOpenItem({ id: userId }, { owner: target.ownerId ? { id: target.ownerId } : null, visibility: readVisibility(target.visibility) })) {
      return { ok: false, reason: 'not-found' };
    }
    await run(tx.update(users).set({ defaultDashboardId: dashboardId, defaultDashboardUnavailable: false }).where(eq(users.id, userId)));
    return { ok: true };
  });
}

/**
 * Clears every My default whose dashboard its person can no longer open (gone, or Personal and someone
 * else's) and sets their unavailable flag. Runs on the transaction of the delete, unshare or user removal
 * that made it so, so nobody is ever left pointing at a dashboard that is not there for them.
 */
export async function clearUnreachableMyDefaultsOn(tx: DbHandle): Promise<void> {
  const chosen = await many(tx.select({ id: users.id, dashboardId: users.defaultDashboardId })
    .from(users).where(isNotNull(users.defaultDashboardId)));
  if (chosen.length === 0) return;

  const reachable = new Map<string, { ownerId: string | null; visibility: string }>();
  for (const ids of chunk([...new Set(chosen.map(c => c.dashboardId!))])) {
    for (const d of await many(tx.select({ id: dashboards.id, ownerId: dashboards.ownerId, visibility: dashboards.visibility })
      .from(dashboards).where(inArray(dashboards.id, ids)))) {
      reachable.set(d.id, d);
    }
  }
  const lost = chosen.filter(c => {
    const d = reachable.get(c.dashboardId!);
    return !d || !canOpenItem({ id: c.id }, { owner: d.ownerId ? { id: d.ownerId } : null, visibility: readVisibility(d.visibility) });
  }).map(c => c.id);
  for (const ids of chunk(lost)) {
    await run(tx.update(users).set({ defaultDashboardId: null, defaultDashboardUnavailable: true }).where(inArray(users.id, ids)));
  }
}

/**
 * Reads the person's unavailable flag and clears it, so the notice is shown once. Only the flag is written:
 * the redirect never stores a choice for them.
 */
export async function takeUnavailableNotice(userId: string): Promise<boolean> {
  return inTransaction(async (tx) => {
    const row = await one(tx.select({ unavailable: users.defaultDashboardUnavailable }).from(users).where(eq(users.id, userId)));
    if (!row?.unavailable) return false;
    await run(tx.update(users).set({ defaultDashboardUnavailable: false }).where(and(eq(users.id, userId), eq(users.defaultDashboardUnavailable, true))));
    return true;
  });
}
