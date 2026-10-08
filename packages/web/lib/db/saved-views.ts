import { db } from '@/lib/db/client';
import { savedViews } from '@/lib/db/tables';
import { eq } from 'drizzle-orm';
import { many, one, run, inTransaction, pgAdvisoryXactLock, type DbHandle } from '@/lib/db/exec';
import { isSavedViewTab, type SavedView, type SavedViewFields } from '@/lib/saved-view-query';

/**
 * Saved views: a View kept under a name and shared with everyone on the install.
 *
 * A name is unique case-insensitively (ignoring surrounding spaces), but there is no unique index:
 * an index would make a clash a startup failure on any install that ever held two names differing
 * only by case, and an upgrade must never disturb existing data. The check lives here instead, in
 * the same transaction as the write, the way rule and dashboard names do. On SQLite
 * `inTransaction()` already serializes every writer; on Postgres every write takes
 * `pgAdvisoryXactLock()` first so two concurrent writers cannot both pass the check.
 */
const SAVED_VIEW_NAME_LOCK_KEY = 7194826112;

type Row = typeof savedViews.$inferSelect;

function rowToView(row: Row): SavedView {
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
  };
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Every saved view, by name regardless of case. Sorted here rather than in SQL so SQLite and
 *  Postgres, whose collations differ, list them in the same order. */
export async function listSavedViews(): Promise<SavedView[]> {
  const rows = await many(db.select().from(savedViews));
  return rows
    .map(rowToView)
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
}

export async function getSavedView(id: string): Promise<SavedView | null> {
  const row = await one(db.select().from(savedViews).where(eq(savedViews.id, id)));
  return row ? rowToView(row) : null;
}

async function isNameTaken(tx: DbHandle, name: string, excludeId?: string): Promise<boolean> {
  const all = await many(tx.select({ id: savedViews.id, name: savedViews.name }).from(savedViews));
  return all.some(v => v.id !== excludeId && sameName(v.name, name));
}

export type CreateSavedViewResult =
  | { ok: true; view: SavedView }
  | { ok: false; reason: 'name-taken' };

export async function createSavedView(
  data: SavedViewFields,
  actorId: string | null,
): Promise<CreateSavedViewResult> {
  const name = data.name.trim();
  return inTransaction(async (tx) => {
    await pgAdvisoryXactLock(tx, SAVED_VIEW_NAME_LOCK_KEY);
    if (await isNameTaken(tx, name)) return { ok: false, reason: 'name-taken' } as const;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await run(tx.insert(savedViews).values({
      id, name, tab: data.tab, query: data.query,
      createdBy: actorId, createdAt: now, updatedBy: actorId, updatedAt: now,
    }));
    const stored = await one(tx.select().from(savedViews).where(eq(savedViews.id, id)));
    return { ok: true, view: rowToView(stored!) } as const;
  });
}

export type UpdateSavedViewResult =
  | { ok: true; view: SavedView; before: SavedView }
  | { ok: false; reason: 'not-found' | 'name-taken' };

// The name is only checked when it actually changes (compared the same way the check compares), so
// an install holding a pre-existing clashing pair can still save either one without renaming it.
export async function updateSavedView(
  id: string,
  data: Partial<SavedViewFields>,
  actorId: string | null,
): Promise<UpdateSavedViewResult> {
  return inTransaction(async (tx) => {
    await pgAdvisoryXactLock(tx, SAVED_VIEW_NAME_LOCK_KEY);
    const existing = await one(tx.select().from(savedViews).where(eq(savedViews.id, id)));
    if (!existing) return { ok: false, reason: 'not-found' } as const;
    const name = data.name?.trim();
    if (name !== undefined && !sameName(name, existing.name) && await isNameTaken(tx, name, id)) {
      return { ok: false, reason: 'name-taken' } as const;
    }
    await run(tx.update(savedViews).set({
      ...(name !== undefined && { name }),
      ...(data.tab !== undefined && { tab: data.tab }),
      ...(data.query !== undefined && { query: data.query }),
      updatedBy: actorId,
      updatedAt: new Date().toISOString(),
    }).where(eq(savedViews.id, id)));
    const stored = await one(tx.select().from(savedViews).where(eq(savedViews.id, id)));
    return { ok: true, view: rowToView(stored!), before: rowToView(existing) } as const;
  });
}

/** Removes a saved view. Returns the view that was removed, or null when there was none. */
export async function deleteSavedView(id: string): Promise<SavedView | null> {
  return inTransaction(async (tx) => {
    const existing = await one(tx.select().from(savedViews).where(eq(savedViews.id, id)));
    if (!existing) return null;
    await run(tx.delete(savedViews).where(eq(savedViews.id, id)));
    return rowToView(existing);
  });
}
