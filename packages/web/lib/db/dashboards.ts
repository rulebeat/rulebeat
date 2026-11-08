import { db } from './client';
import { dashboards } from './tables';
import { eq, ne, and, sql } from 'drizzle-orm';
import { many, one, run, inTransaction, pgAdvisoryXactLock, type DbHandle } from './exec';
import type { Dashboard, DashboardConfig, ItemOwner } from '@/lib/types';
import { loadItemOwners, readVisibility } from './item-owners';
import { STARTER_DASHBOARD } from '@/lib/dashboard-templates';
import { migrateDashboardConfig } from '@/lib/dashboard-migrations';
import { clearUnreachableMyDefaultsOn, DASHBOARD_NAME_LOCK_KEY } from './default-dashboard';

type Row = typeof dashboards.$inferSelect;

function rowToDashboard(row: Row, owners: Map<string, ItemOwner>): Dashboard {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    config: migrateDashboardConfig(JSON.parse(row.config) as DashboardConfig),
    isDefault: row.isDefault ?? false,
    isInstallDefault: (row.isDefault ?? false) && readVisibility(row.visibility) === 'shared',
    createdAt: row.createdAt,
    owner: (row.ownerId && owners.get(row.ownerId)) || null,
    visibility: readVisibility(row.visibility),
    revision: row.revision,
  };
}

async function toDashboards(rows: Row[], handle: DbHandle = db): Promise<Dashboard[]> {
  const owners = await loadItemOwners(rows.map(r => r.ownerId), handle);
  return rows.map(row => rowToDashboard(row, owners));
}

export async function listDashboards(): Promise<Dashboard[]> {
  return toDashboards(await many(db.select().from(dashboards)));
}

export async function getDashboard(id: string): Promise<Dashboard | null> {
  const row = await one(db.select().from(dashboards).where(eq(dashboards.id, id)));
  return row ? (await toDashboards([row]))[0] : null;
}

/**
 * Issue #161: a dashboard name is meant to be unique (case-insensitively, ignoring surrounding
 * spaces), but there is no unique index, since an existing install can already hold names that
 * differ only by case or spacing and an upgrade must never disturb those rows. The check lives in
 * the application instead, in the same transaction as the write, the way rule names do (see
 * `lib/rules.ts`).
 *
 * On SQLite `inTransaction()` already serializes every writer through a process-wide lock. On
 * Postgres (READ COMMITTED) two open transactions cannot see each other's uncommitted row, so every
 * write here takes `pgAdvisoryXactLock()` first, which is a no-op on SQLite.
 */
// The key itself lives in default-dashboard.ts, which takes it too (My default is written under it).

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Where a name has to be free (ADR 0012): a Personal name among its owner's Personal items, a Shared
 * name among Shared items install-wide. No check reads another person's Personal names, so a clash
 * never tells anyone what someone else keeps.
 */
type NameSpace = { visibility: 'personal'; ownerId: string } | { visibility: 'shared' };

export async function isNameTaken(name: string, space: NameSpace, excludeId?: string, handle: DbHandle = db): Promise<boolean> {
  const rows = await many(handle.select({ id: dashboards.id, name: dashboards.name, ownerId: dashboards.ownerId, visibility: dashboards.visibility }).from(dashboards));
  return rows.some(d => d.id !== excludeId && sameName(d.name, name) && (
    space.visibility === 'personal'
      ? readVisibility(d.visibility) === 'personal' && d.ownerId === space.ownerId
      : readVisibility(d.visibility) === 'shared'
  ));
}

/** The 409 message both dashboard-save routes return when a name is already in use. */
export function dashboardNameTakenMessage(name: string): string {
  return `A dashboard named "${name}" already exists.`;
}

// Inserts one Personal row on `tx`, which the caller has already locked and checked a free name on.
// Nothing becomes the Install default by being first (ADR 0012): an Admin or an Editor on Everything
// chooses it, from the Shared dashboards.
async function insertDashboard(tx: DbHandle, ownerId: string, data: { name: string; description?: string; config: DashboardConfig }): Promise<Dashboard> {
  const id = crypto.randomUUID();
  await run(tx.insert(dashboards).values({
    id,
    name: data.name.trim(),
    description: data.description ?? null,
    config: JSON.stringify(data.config),
    isDefault: false,
    createdAt: new Date().toISOString(),
    // Spelled out so no insert depends on the column default.
    ownerId,
    visibility: 'personal',
    revision: 1,
  }));
  const stored = await one(tx.select().from(dashboards).where(eq(dashboards.id, id)));
  return (await toDashboards([stored!], tx))[0];
}

export type CreateDashboardResult =
  | { ok: true; dashboard: Dashboard }
  | { ok: false; reason: 'empty-name' }
  | { ok: false; reason: 'name-taken' };

/** Creates a Personal dashboard owned by `ownerId`. */
export async function createDashboard(data: { name: string; description?: string; config: DashboardConfig }, ownerId: string): Promise<CreateDashboardResult> {
  if (!data.name.trim()) return { ok: false, reason: 'empty-name' };
  return inTransaction(async (tx) => {
    await pgAdvisoryXactLock(tx, DASHBOARD_NAME_LOCK_KEY);
    if (await isNameTaken(data.name, { visibility: 'personal', ownerId }, undefined, tx)) return { ok: false, reason: 'name-taken' };
    return { ok: true, dashboard: await insertDashboard(tx, ownerId, data) };
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
      const space: NameSpace = readVisibility(existing.visibility) === 'shared' || !existing.ownerId
        ? { visibility: 'shared' }
        : { visibility: 'personal', ownerId: existing.ownerId };
      if (renamed && await isNameTaken(trimmed, space, id, tx)) return { ok: false, reason: 'name-taken' };
      data = { ...data, name: trimmed };
    }
    await run(tx.update(dashboards).set({
      ...(data.name !== undefined && { name: data.name }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.config !== undefined && { config: JSON.stringify(data.config) }),
      revision: sql`${dashboards.revision} + 1`,
    }).where(eq(dashboards.id, id)));
    const stored = await one(tx.select().from(dashboards).where(eq(dashboards.id, id)));
    return { ok: true, dashboard: (await toDashboards([stored!], tx))[0] };
  });
}

export type ShareDashboardResult =
  | { ok: true; dashboard: Dashboard }
  | { ok: false; reason: 'not-found' | 'name-taken' | 'wrong-state' };

/**
 * Makes a Personal dashboard Shared, if it still is Personal and its name is free among Shared names
 * install-wide. Both checks and the write are one locked transaction, so a second click or a concurrent
 * share finds the state already changed and gets `wrong-state`.
 */
export async function shareDashboard(id: string): Promise<ShareDashboardResult> {
  return inTransaction(async (tx) => {
    await pgAdvisoryXactLock(tx, DASHBOARD_NAME_LOCK_KEY);
    const existing = await one(tx.select().from(dashboards).where(eq(dashboards.id, id)));
    if (!existing) return { ok: false, reason: 'not-found' };
    if (readVisibility(existing.visibility) !== 'personal') return { ok: false, reason: 'wrong-state' };
    if (await isNameTaken(existing.name, { visibility: 'shared' }, id, tx)) return { ok: false, reason: 'name-taken' };
    await run(tx.update(dashboards).set({ visibility: 'shared', revision: sql`${dashboards.revision} + 1` }).where(eq(dashboards.id, id)));
    const stored = await one(tx.select().from(dashboards).where(eq(dashboards.id, id)));
    return { ok: true, dashboard: (await toDashboards([stored!], tx))[0] };
  });
}

export type UnshareDashboardResult =
  | { ok: true; dashboard: Dashboard; sharedName: string; wasInstallDefault: boolean }
  | { ok: false; reason: 'not-found' | 'name-taken' | 'wrong-state' | 'no-owner' | 'install-default' };

/**
 * Makes a Shared dashboard Personal again, to its owner. The owner's own unshare is refused when the name
 * clashes with one of their Personal names; anyone else's unshare gives it the next free name instead, so it
 * never fails on a clash. It stops being the Install default, which has to be Shared, and a My default
 * that pointed at it for anyone but the owner is cleared. `dashboard` holds
 * the new name, so the caller returns it only to the owner; `sharedName` is the name it had while Shared.
 * Whether it is the Install default is read on the transaction, not before it: someone who may not remove the
 * Install default (`mayRemoveInstallDefault` false) gets `install-default`, and `wasInstallDefault` is what the
 * caller audits.
 */
export async function unshareDashboard(id: string, actorId: string, mayRemoveInstallDefault: boolean): Promise<UnshareDashboardResult> {
  return inTransaction(async (tx) => {
    await pgAdvisoryXactLock(tx, DASHBOARD_NAME_LOCK_KEY);
    const existing = await one(tx.select().from(dashboards).where(eq(dashboards.id, id)));
    if (!existing) return { ok: false, reason: 'not-found' };
    if (readVisibility(existing.visibility) !== 'shared') return { ok: false, reason: 'wrong-state' };
    const wasInstallDefault = existing.isDefault ?? false;
    if (wasInstallDefault && !mayRemoveInstallDefault) return { ok: false, reason: 'install-default' };
    if (!existing.ownerId) return { ok: false, reason: 'no-owner' };
    const space: NameSpace = { visibility: 'personal', ownerId: existing.ownerId };
    let name = existing.name;
    if (await isNameTaken(name, space, id, tx)) {
      if (existing.ownerId === actorId) return { ok: false, reason: 'name-taken' };
      name = await nextFreeName(tx, existing.ownerId, existing.name, n => `${existing.name} (${n})`);
    }
    await run(tx.update(dashboards).set({ name, visibility: 'personal', isDefault: false, revision: sql`${dashboards.revision} + 1` }).where(eq(dashboards.id, id)));
    await clearUnreachableMyDefaultsOn(tx);
    const stored = await one(tx.select().from(dashboards).where(eq(dashboards.id, id)));
    return { ok: true, dashboard: (await toDashboards([stored!], tx))[0], sharedName: existing.name, wasInstallDefault };
  });
}

// Every dashboard is deletable, including the default. Deleting the default leaves the install with
// none: no other dashboard is promoted for being the oldest (ADR 0012). A My default that pointed at
// it is cleared in the same transaction.
export async function deleteDashboard(id: string): Promise<boolean> {
  return (await deleteDashboardAs(id, true)).ok;
}

export type DeleteDashboardResult =
  | { ok: true; wasInstallDefault: boolean }
  | { ok: false; reason: 'not-found' | 'install-default' };

/**
 * Deletes a dashboard, reading whether it is the Install default on the transaction that deletes it: someone
 * who may not remove the Install default (`mayRemoveInstallDefault` false) gets `install-default`, and
 * `wasInstallDefault` is what the caller audits.
 */
export async function deleteDashboardAs(id: string, mayRemoveInstallDefault: boolean): Promise<DeleteDashboardResult> {
  return inTransaction(async (tx) => {
    // The same lock `chooseInstallDefault()` takes: without it, on Postgres, a delete could read the
    // flag as unset while a choice commits, and then remove the new Install default unchecked.
    await pgAdvisoryXactLock(tx, DASHBOARD_NAME_LOCK_KEY);
    const row = await one(tx.select().from(dashboards).where(eq(dashboards.id, id)));
    if (!row) return { ok: false, reason: 'not-found' };
    const wasInstallDefault = (row.isDefault ?? false) && readVisibility(row.visibility) === 'shared';
    if (wasInstallDefault && !mayRemoveInstallDefault) return { ok: false, reason: 'install-default' };
    await run(tx.delete(dashboards).where(eq(dashboards.id, id)));
    await clearUnreachableMyDefaultsOn(tx);
    return { ok: true, wasInstallDefault };
  });
}

// Moves the default flag to `id` on `tx`, clearing it on every other row.
async function moveDefaultFlagOn(tx: DbHandle, id: string): Promise<void> {
  // Only the rows whose flag actually changes are written, so only they move to a new revision.
  await run(tx.update(dashboards).set({ isDefault: false, revision: sql`${dashboards.revision} + 1` })
    .where(and(eq(dashboards.isDefault, true), ne(dashboards.id, id))));
  await run(tx.update(dashboards).set({ isDefault: true, revision: sql`${dashboards.revision} + 1` })
    .where(and(eq(dashboards.id, id), eq(dashboards.isDefault, false))));
}

// Makes `id` the default dashboard, clearing the flag on every other row. Returns false if `id`
// doesn't exist. It checks nothing else: `chooseInstallDefault()` is what a person's choice goes through.
export async function setDefaultDashboard(id: string): Promise<boolean> {
  const row = await one(db.select().from(dashboards).where(eq(dashboards.id, id)));
  if (!row) return false;
  await inTransaction(tx => moveDefaultFlagOn(tx, id));
  return true;
}

export type ChooseInstallDefaultResult =
  | { ok: true; dashboard: Dashboard }
  | { ok: false; reason: 'not-found' | 'personal' };

/**
 * Makes a Shared dashboard the Install default (ADR 0012). The state check and the write are one transaction
 * under the name lock, so a dashboard unshared at the same moment cannot end up the default while Personal.
 */
export async function chooseInstallDefault(id: string): Promise<ChooseInstallDefaultResult> {
  return inTransaction(async (tx) => {
    await pgAdvisoryXactLock(tx, DASHBOARD_NAME_LOCK_KEY);
    const existing = await one(tx.select().from(dashboards).where(eq(dashboards.id, id)));
    if (!existing) return { ok: false, reason: 'not-found' };
    if (readVisibility(existing.visibility) !== 'shared') return { ok: false, reason: 'personal' };
    await moveDefaultFlagOn(tx, id);
    const stored = await one(tx.select().from(dashboards).where(eq(dashboards.id, id)));
    return { ok: true, dashboard: (await toDashboards([stored!], tx))[0] };
  });
}

/** The id of the Install default, if the install has one: the default flag on a Shared dashboard. */
export async function getInstallDefaultId(): Promise<string | null> {
  const row = await one(db.select({ id: dashboards.id }).from(dashboards)
    .where(and(eq(dashboards.isDefault, true), eq(dashboards.visibility, 'shared'))));
  return row?.id ?? null;
}

// Picks the first name free among `ownerId`'s Personal names out of `base`, then `suffix(2)`,
// `suffix(3)`, ... on `tx`. The caller holds the name lock, so the name it gets back is still free
// when it inserts.
async function nextFreeName(tx: DbHandle, ownerId: string, base: string, suffix: (n: number) => string): Promise<string> {
  let name = base;
  let n = 2;
  while (await isNameTaken(name, { visibility: 'personal', ownerId }, undefined, tx)) name = suffix(n++);
  return name;
}

// Copies a dashboard the person can open into a Personal one of their own: neither the Install default
// flag nor the owner is carried over, and widget config (a `savedViewId` included) is copied as it is.
// Picks the copy's name and inserts it in one locked transaction, so concurrent duplicates of one
// dashboard each land on a different name.
export async function duplicateDashboard(id: string, ownerId: string): Promise<Dashboard | null> {
  return inTransaction(async (tx) => {
    await pgAdvisoryXactLock(tx, DASHBOARD_NAME_LOCK_KEY);
    const row = await one(tx.select().from(dashboards).where(eq(dashboards.id, id)));
    if (!row) return null;
    const src = (await toDashboards([row], tx))[0];
    const name = await nextFreeName(tx, ownerId, `${src.name} (copy)`, n => `${src.name} (copy ${n})`);
    return insertDashboard(tx, ownerId, {
      name,
      description: src.description,
      config: JSON.parse(JSON.stringify(src.config)) as DashboardConfig,
    });
  });
}

// Restores the original starter dashboard as a new Personal row, e.g. from the gallery's empty state
// after a person has deleted every dashboard of their own. Named like duplicateDashboard's own dedupe loop.
export async function createStarterDashboard(ownerId: string): Promise<Dashboard> {
  return inTransaction(async (tx) => {
    await pgAdvisoryXactLock(tx, DASHBOARD_NAME_LOCK_KEY);
    const name = await nextFreeName(tx, ownerId, STARTER_DASHBOARD.name, n => `${STARTER_DASHBOARD.name} (${n})`);
    return insertDashboard(tx, ownerId, {
      name,
      description: STARTER_DASHBOARD.description,
      config: JSON.parse(JSON.stringify(STARTER_DASHBOARD.config)) as DashboardConfig,
    });
  });
}
