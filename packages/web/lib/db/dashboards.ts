import { db } from './client';
import { dashboards } from './tables';
import { eq, asc } from 'drizzle-orm';
import { many, one, run, inTransaction } from './exec';
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

export async function isNameTaken(name: string, excludeId?: string): Promise<boolean> {
  const all = await many(db.select().from(dashboards));
  return all.some(d => d.name.trim().toLowerCase() === name.trim().toLowerCase() && d.id !== excludeId);
}

export async function createDashboard(data: { name: string; description?: string; config: DashboardConfig }): Promise<{ dashboard: Dashboard } | { error: string }> {
  if (!data.name.trim()) return { error: 'Name is required.' };
  if (await isNameTaken(data.name)) return { error: `A dashboard named "${data.name}" already exists.` };
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // A fresh empty-state "Create dashboard" should always produce a usable default.
  const isFirstDashboard = (await listDashboards()).length === 0;
  await run(db.insert(dashboards).values({
    id,
    name: data.name.trim(),
    description: data.description ?? null,
    config: JSON.stringify(data.config),
    isDefault: isFirstDashboard,
    createdAt: now,
  }));
  return { dashboard: (await getDashboard(id))! };
}

export async function updateDashboard(id: string, data: Partial<{ name: string; description: string; config: DashboardConfig }>): Promise<{ dashboard: Dashboard } | { error: string } | null> {
  const existing = await getDashboard(id);
  if (!existing) return null;
  if (data.name !== undefined) {
    const trimmed = data.name.trim();
    if (!trimmed) return { error: 'Name cannot be empty.' };
    if (await isNameTaken(trimmed, id)) return { error: `A dashboard named "${trimmed}" already exists.` };
    data = { ...data, name: trimmed };
  }
  await run(db.update(dashboards).set({
    ...(data.name !== undefined && { name: data.name }),
    ...(data.description !== undefined && { description: data.description }),
    ...(data.config !== undefined && { config: JSON.stringify(data.config) }),
  }).where(eq(dashboards.id, id)));
  return { dashboard: (await getDashboard(id))! };
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

export async function duplicateDashboard(id: string): Promise<Dashboard | null> {
  const src = await getDashboard(id);
  if (!src) return null;
  let name = `${src.name} (copy)`;
  let n = 2;
  while (await isNameTaken(name)) { name = `${src.name} (copy ${n++})`; }
  const result = await createDashboard({
    name,
    description: src.description,
    config: JSON.parse(JSON.stringify(src.config)) as DashboardConfig,
  });
  return 'error' in result ? null : result.dashboard;
}

// Restores the original starter dashboard as a new row — e.g. from the gallery's empty state
// after a user has deleted every dashboard. Named like duplicateDashboard's own dedupe loop.
// createDashboard already auto-defaults the very first dashboard in an empty table, so this
// relies on that rather than calling setDefaultDashboard itself.
export async function createStarterDashboard(): Promise<Dashboard> {
  let name = STARTER_DASHBOARD.name;
  let n = 2;
  while (await isNameTaken(name)) { name = `${STARTER_DASHBOARD.name} (${n++})`; }
  const result = await createDashboard({
    name,
    description: STARTER_DASHBOARD.description,
    config: JSON.parse(JSON.stringify(STARTER_DASHBOARD.config)) as DashboardConfig,
  });
  if ('error' in result) throw new Error(result.error);
  return result.dashboard;
}
