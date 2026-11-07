import { db } from '@/lib/db/client';
import { savedViews } from '@/lib/db/tables';
import { eq, sql } from 'drizzle-orm';
import { many, one, run, inTransaction, pgAdvisoryXactLock, type DbHandle } from '@/lib/db/exec';
import { loadItemOwners, readVisibility } from '@/lib/db/item-owners';
import type { ItemOwner } from '@/lib/types';
import { isSavedViewTab, type SavedView, type SavedViewFields } from '@/lib/saved-view-query';

/**
 * Saved views: a View kept under a name. A new one is Personal, its owner's alone; a Shared one is open to
 * everyone on the install (ADR 0012).
 *
 * A Personal name is unique among its owner's Personal views, a Shared name among Shared views, both
 * case-insensitively (ignoring surrounding spaces), and no check reads another person's Personal names.
 * There is no unique index:
 * an index would make a clash a startup failure on any install that ever held two names differing
 * only by case, and an upgrade must never disturb existing data. The check lives here instead, in
 * the same transaction as the write, the way rule and dashboard names do. On SQLite
 * `inTransaction()` already serializes every writer; on Postgres every write takes
 * `pgAdvisoryXactLock()` first so two concurrent writers cannot both pass the check.
 */
const SAVED_VIEW_NAME_LOCK_KEY = 7194826112;

type Row = typeof savedViews.$inferSelect;

function rowToView(row: Row, owners: Map<string, ItemOwner>): SavedView {
  return {
    id: row.id,
    name: row.name,
    // The tab is validated on write; a row written some other way opens on Results rather than failing.
    tab: isSavedViewTab(row.tab) ? row.tab : 'results',
    query: row.query,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt,
    updatedBy: row.updatedBy ?? null,
    updatedAt: row.updatedAt,
    owner: (row.ownerId && owners.get(row.ownerId)) || null,
    visibility: readVisibility(row.visibility),
    revision: row.revision,
  };
}

async function toViews(rows: Row[], handle: DbHandle = db): Promise<SavedView[]> {
  const owners = await loadItemOwners(rows.map(r => r.ownerId), handle);
  return rows.map(row => rowToView(row, owners));
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Every saved view, by name regardless of case. Sorted here rather than in SQL so SQLite and
 *  Postgres, whose collations differ, list them in the same order. */
export async function listSavedViews(): Promise<SavedView[]> {
  const rows = await many(db.select().from(savedViews));
  return (await toViews(rows))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
}

export async function getSavedView(id: string): Promise<SavedView | null> {
  const row = await one(db.select().from(savedViews).where(eq(savedViews.id, id)));
  return row ? (await toViews([row]))[0] : null;
}

type NameSpace = { visibility: 'personal'; ownerId: string } | { visibility: 'shared' };

/** The name space a stored row's name has to be free in. A Personal row with no owner is read as Shared. */
const spaceOf = (row: { visibility: string; ownerId: string | null }): NameSpace =>
  readVisibility(row.visibility) === 'personal' && row.ownerId ? { visibility: 'personal', ownerId: row.ownerId } : { visibility: 'shared' };

async function isNameTaken(tx: DbHandle, name: string, space: NameSpace, excludeId?: string): Promise<boolean> {
  const all = await many(tx.select({ id: savedViews.id, name: savedViews.name, ownerId: savedViews.ownerId, visibility: savedViews.visibility }).from(savedViews));
  return all.some(v => v.id !== excludeId && sameName(v.name, name) && (
    space.visibility === 'personal'
      ? readVisibility(v.visibility) === 'personal' && v.ownerId === space.ownerId
      : readVisibility(v.visibility) === 'shared'
  ));
}

export type CreateSavedViewResult =
  | { ok: true; view: SavedView }
  | { ok: false; reason: 'name-taken' };

/** Creates a Personal saved view owned by `actorId`. */
export async function createSavedView(
  data: SavedViewFields,
  actorId: string,
): Promise<CreateSavedViewResult> {
  const name = data.name.trim();
  return inTransaction(async (tx) => {
    await pgAdvisoryXactLock(tx, SAVED_VIEW_NAME_LOCK_KEY);
    if (await isNameTaken(tx, name, { visibility: 'personal', ownerId: actorId })) return { ok: false, reason: 'name-taken' } as const;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await run(tx.insert(savedViews).values({
      id, name, tab: data.tab, query: data.query,
      // Spelled out so no insert depends on the column default.
      ownerId: actorId, visibility: 'personal', revision: 1,
      createdBy: actorId, createdAt: now, updatedBy: actorId, updatedAt: now,
    }));
    const stored = await one(tx.select().from(savedViews).where(eq(savedViews.id, id)));
    return { ok: true, view: (await toViews([stored!], tx))[0] } as const;
  });
}

export type UpdateSavedViewResult =
  | { ok: true; view: SavedView; before: SavedView }
  | { ok: false; reason: 'not-found' | 'name-taken' | 'conflict' };

/** `ifRevision` makes the write conditional: it is refused as a `conflict` when the row has moved to another revision. */
export interface UpdateGuard { ifRevision?: number }

// The name is only checked when it actually changes (compared the same way the check compares), so
// an install holding a pre-existing clashing pair can still save either one without renaming it.
export async function updateSavedView(
  id: string,
  data: Partial<SavedViewFields>,
  actorId: string | null,
  guard: UpdateGuard = {},
): Promise<UpdateSavedViewResult> {
  return inTransaction(async (tx) => {
    await pgAdvisoryXactLock(tx, SAVED_VIEW_NAME_LOCK_KEY);
    const existing = await one(tx.select().from(savedViews).where(eq(savedViews.id, id)));
    if (!existing) return { ok: false, reason: 'not-found' } as const;
    if (guard.ifRevision !== undefined && existing.revision !== guard.ifRevision) return { ok: false, reason: 'conflict' } as const;
    const name = data.name?.trim();
    if (name !== undefined && !sameName(name, existing.name) && await isNameTaken(tx, name, spaceOf(existing), id)) {
      return { ok: false, reason: 'name-taken' } as const;
    }
    await run(tx.update(savedViews).set({
      ...(name !== undefined && { name }),
      ...(data.tab !== undefined && { tab: data.tab }),
      ...(data.query !== undefined && { query: data.query }),
      updatedBy: actorId,
      updatedAt: new Date().toISOString(),
      revision: sql`${savedViews.revision} + 1`,
    }).where(eq(savedViews.id, id)));
    const stored = await one(tx.select().from(savedViews).where(eq(savedViews.id, id)));
    const [view, before] = await toViews([stored!, existing], tx);
    return { ok: true, view, before } as const;
  });
}

/** Removes a saved view. Returns the view that was removed, or null when there was none. */
export async function deleteSavedView(id: string): Promise<SavedView | null> {
  return inTransaction(async (tx) => {
    const existing = await one(tx.select().from(savedViews).where(eq(savedViews.id, id)));
    if (!existing) return null;
    await run(tx.delete(savedViews).where(eq(savedViews.id, id)));
    return (await toViews([existing], tx))[0];
  });
}
