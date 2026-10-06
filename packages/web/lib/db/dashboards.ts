import { db } from './client';
import { dashboards } from './tables';
import { eq, asc } from 'drizzle-orm';
import { many, one, run, inTransaction, pgAdvisoryXactLock, type DbHandle } from './exec';
import type { Dashboard, DashboardConfig } from '@/lib/types';
import { STARTER_DASHBOARD } from '@/lib/dashboard-templates';
import { migrateDashboardConfig } from '@/lib/dashboard-migrations';

function rowToDashboard(row: typeof dashboards.$inferSelect): Dashboard {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    config: migrateDashboardConfig(JSON.parse(row.config) as DashboardConfig),
    isDefault: row.isDefault ?? false,
    createdAt: row.createdAt,
  };
}

export async function listDashboards(): Promise<Dashboard[]> {
  const rows = await many(db.select().from(dashboards));
  return rows.map(rowToDashboard);
}

export async function getDashboard(id: string): Promise<Dashboard | null> {
  const row = await one(db.select().from(dashboards).where(eq(dashboards.id, id)));
  return row ? rowToDashboard(row) : null;
}

/**
 * Issue #161: a dashboard name is meant to be unique (case-insensitively, ignoring surrounding
 * spaces), but there is no unique index, since an existing install can already hold names that
 * differ only by case or spacing and an upgrade must never disturb those rows. The check lives in
 * the application instead, in the same transaction as the write, the way rule names do (see
 * `lib/rules.ts`). The same transaction reads whether the table is empty, so two first creates
 * cannot both become the default.
 *
 * On SQLite `inTransaction()` already serializes every writer through a process-wide lock. On
 * Postgres (READ COMMITTED) two open transactions cannot see each other's uncommitted row, so every
 * write here takes `pgAdvisoryXactLock()` first, which is a no-op on SQLite.
 */
const DASHBOARD_NAME_LOCK_KEY = 7194826034;

export async function isNameTaken(name: string, excludeId?: string, handle: DbHandle = db): Promise<boolean> {
  const all = await many(handle.select().from(dashboards));
  return all.some(d => d.name.trim().toLowerCase() === name.trim().toLowerCase() && d.id !== excludeId);
}

/** The 409 message both dashboard-save routes return when a name is already in use. */
export function dashboardNameTakenMessage(name: string): string {
  return `A dashboard named "${name}" already exists.`;
}

// Inserts one row on `tx`, which the caller has already locked and checked a free name on. The very
// first dashboard in an empty table is the default, so a fresh empty-state "Create dashboard"
// always produces a usable one.
async function insertDashboard(tx: DbHandle, data: { name: string; description?: string; config: DashboardConfig }): Promise<Dashboard> {
  const id = crypto.randomUUID();
  const isFirstDashboard = (await many(tx.select({ id: dashboards.id }).from(dashboards).limit(1))).length === 0;
  await run(tx.insert(dashboards).values({
    id,
    name: data.name.trim(),
    description: data.description ?? null,
    config: JSON.stringify(data.config),
    isDefault: isFirstDashboard,
    createdAt: new Date().toISOString(),
  }));
  const stored = await one(tx.select().from(dashboards).where(eq(dashboards.id, id)));
  return rowToDashboard(stored!);
}

export type CreateDashboardResult =
  | { ok: true; dashboard: Dashboard }
  | { ok: false; reason: 'empty-name' }
  | { ok: false; reason: 'name-taken' };

export async function createDashboard(data: { name: string; description?: string; config: DashboardConfig }): Promise<CreateDashboardResult> {
  if (!data.name.trim()) return { ok: false, reason: 'empty-name' };
  return inTransaction(async (tx) => {
    await pgAdvisoryXactLock(tx, DASHBOARD_NAME_LOCK_KEY);
    if (await isNameTaken(data.name, undefined, tx)) return { ok: false, reason: 'name-taken' };
    return { ok: true, dashboard: await insertDashboard(tx, data) };
  });
}

export type UpdateDashboardResult =
  | { ok: true; dashboard: Dashboard }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'empty-name' }
  | { ok: false; reason: 'name-taken' };

// The name is only checked when it actually changes (compared case-insensitively, after trimming,
// against the stored one): an install can already hold a pre-existing duplicate pair, and saving
// one of them without renaming it must keep working.
export async function updateDashboard(id: string, data: Partial<{ name: string; description: string; config: DashboardConfig }>): Promise<UpdateDashboardResult> {
  return inTransaction(async (tx) => {
    await pgAdvisoryXactLock(tx, DASHBOARD_NAME_LOCK_KEY);
    const existing = await one(tx.select().from(dashboards).where(eq(dashboards.id, id)));
    if (!existing) return { ok: false, reason: 'not-found' };
    if (data.name !== undefined) {
      const trimmed = data.name.trim();
      if (!trimmed) return { ok: false, reason: 'empty-name' };
      const renamed = trimmed.toLowerCase() !== existing.name.trim().toLowerCase();
      if (renamed && await isNameTaken(trimmed, id, tx)) return { ok: false, reason: 'name-taken' };
      data = { ...data, name: trimmed };
    }
    await run(tx.update(dashboards).set({
      ...(data.name !== undefined && { name: data.name }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.config !== undefined && { config: JSON.stringify(data.config) }),
    }).where(eq(dashboards.id, id)));
    const stored = await one(tx.select().from(dashboards).where(eq(dashboards.id, id)));
    return { ok: true, dashboard: rowToDashboard(stored!) };
  });
}

// Every dashboard is now deletable, including the default — if the deleted row was the default
// and other dashboards remain, the oldest remaining one is promoted to default in the same
// transaction. If none remain, the table is left empty (handled by an empty-state UI elsewhere).
export async function deleteDashboard(id: string): Promise<boolean> {
  const row = await one(db.select().from(dashboards).where(eq(dashboards.id, id)));
  if (!row) return false;
  await inTransaction(async (tx) => {
    await run(tx.delete(dashboards).where(eq(dashboards.id, id)));
    if (row.isDefault) {
      const oldest = await one(tx.select().from(dashboards).orderBy(asc(dashboards.createdAt)).limit(1));
      if (oldest) await run(tx.update(dashboards).set({ isDefault: true }).where(eq(dashboards.id, oldest.id)));
    }
  });
  return true;
}

// Makes `id` the default dashboard, clearing the flag on every other row. Returns false if `id`
// doesn't exist.
export async function setDefaultDashboard(id: string): Promise<boolean> {
  const row = await one(db.select().from(dashboards).where(eq(dashboards.id, id)));
  if (!row) return false;
  await inTransaction(async (tx) => {
    await run(tx.update(dashboards).set({ isDefault: false }));
    await run(tx.update(dashboards).set({ isDefault: true }).where(eq(dashboards.id, id)));
  });
  return true;
}

// Picks the first free name among `base`, then `suffix(2)`, `suffix(3)`, ... on `tx`. The caller
// holds the name lock, so the name it gets back is still free when it inserts.
async function nextFreeName(tx: DbHandle, base: string, suffix: (n: number) => string): Promise<string> {
  let name = base;
  let n = 2;
  while (await isNameTaken(name, undefined, tx)) name = suffix(n++);
  return name;
}

// Picks the copy's name and inserts it in one locked transaction, so concurrent duplicates of one
// dashboard each land on a different name.
export async function duplicateDashboard(id: string): Promise<Dashboard | null> {
  return inTransaction(async (tx) => {
    await pgAdvisoryXactLock(tx, DASHBOARD_NAME_LOCK_KEY);
    const row = await one(tx.select().from(dashboards).where(eq(dashboards.id, id)));
    if (!row) return null;
    const src = rowToDashboard(row);
    const name = await nextFreeName(tx, `${src.name} (copy)`, n => `${src.name} (copy ${n})`);
    return insertDashboard(tx, {
      name,
      description: src.description,
      config: JSON.parse(JSON.stringify(src.config)) as DashboardConfig,
    });
  });
}

// Restores the original starter dashboard as a new row, e.g. from the gallery's empty state
// after a user has deleted every dashboard. Named like duplicateDashboard's own dedupe loop.
// insertDashboard already auto-defaults the very first dashboard in an empty table, so this
// relies on that rather than calling setDefaultDashboard itself.
export async function createStarterDashboard(): Promise<Dashboard> {
  return inTransaction(async (tx) => {
    await pgAdvisoryXactLock(tx, DASHBOARD_NAME_LOCK_KEY);
    const name = await nextFreeName(tx, STARTER_DASHBOARD.name, n => `${STARTER_DASHBOARD.name} (${n})`);
    return insertDashboard(tx, {
      name,
      description: STARTER_DASHBOARD.description,
      config: JSON.parse(JSON.stringify(STARTER_DASHBOARD.config)) as DashboardConfig,
    });
  });
}
