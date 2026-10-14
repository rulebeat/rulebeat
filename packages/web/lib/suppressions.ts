import { and, eq, inArray } from 'drizzle-orm';
import { db } from './db/client';
import { accessFilterSql } from './db/access-filter';
import { findings as findingsTable, suppressions as suppressionsTable } from './db/tables';
import { many, one, run, inTransaction, type DbHandle } from './db/exec';
import type { Suppression } from './types';
import type { Access } from './access-model';
import { accessAllowing, type Action } from './rbac';

/**
 * The suppressions a person may see: all of them on Everything, and for anyone else only those on a
 * finding that sits inside a Scope they hold (#275). A suppression whose finding is gone is seen by
 * Everything only, since there is no placement to put inside a Scope.
 */
export async function loadSuppressions(access: Access): Promise<Suppression[]> {
  const inside = accessFilterSql(access);
  const query = inside
    ? db.select().from(suppressionsTable).where(inArray(
        suppressionsTable.fingerprint,
        db.select({ fingerprint: findingsTable.fingerprint }).from(findingsTable).where(inside),
      ))
    : db.select().from(suppressionsTable);
  return (await many(query)).map(rowToSuppression);
}

/**
 * Every suppression, whatever the person's Scopes: what the dashboard widgets read to leave suppressed
 * findings out of a count. Their findings are not narrowed to the person's Scopes until #274, and a
 * suppression the person cannot see must still keep its finding out of the numbers, or a widget body
 * would change for a scoped person. Move this to `loadSuppressions(access)` when #274 narrows them.
 */
export async function loadSuppressionsForWidgets(access: Access): Promise<Suppression[]> {
  void access;
  return (await many(db.select().from(suppressionsTable))).map(rowToSuppression);
}

/**
 * Whether the finding with this fingerprint sits inside a Scope where the person holds a Role that
 * allows `action`. Everything is not asked: an Admin or an Editor on Everything may act on a
 * fingerprint no finding holds, as before. For anyone else a fingerprint no finding holds, and one that
 * sits only in a Scope held at a Role that does not allow the action, both read as outside.
 */
export async function mayActOnFingerprint(access: Access, action: Action, fingerprint: string): Promise<boolean> {
  const allowed = accessAllowing(access, action);
  if (allowed.everything) return true;
  return findingIsInside(db, allowed, fingerprint);
}

async function findingIsInside(handle: DbHandle, allowed: Access, fingerprint: string): Promise<boolean> {
  const row = await one(handle.select({ fingerprint: findingsTable.fingerprint }).from(findingsTable)
    .where(and(eq(findingsTable.fingerprint, fingerprint), accessFilterSql(allowed))));
  return row !== undefined;
}

/** Inserts one suppression without touching the others, so two people suppressing at once both land. */
export async function addSuppression(s: Suppression): Promise<void> {
  await run(db.insert(suppressionsTable).values(suppressionToRow(s)));
}

/**
 * Deletes one suppression by id. Returns the removed suppression, or null if there was none. With
 * `allowedBy`, a suppression whose finding sits outside what that access holds a Role for is left alone
 * and reads as there being none: pass `accessAllowing(actor.access, 'suppressions:write')`.
 */
export async function removeSuppression(id: string, allowedBy?: Access): Promise<Suppression | null> {
  return inTransaction(async (tx) => {
    const row = await one(tx.select().from(suppressionsTable).where(eq(suppressionsTable.id, id)));
    if (!row) return null;
    if (allowedBy && !allowedBy.everything && !(await findingIsInside(tx, allowedBy, row.fingerprint))) return null;
    await run(tx.delete(suppressionsTable).where(eq(suppressionsTable.id, id)));
    return rowToSuppression(row);
  });
}

/** Replaces the whole set. No route uses it; it remains for test fixtures that need an exact set. */
export async function saveSuppressions(sups: Suppression[]): Promise<void> {
  await inTransaction(async (tx) => {
    await run(tx.delete(suppressionsTable));
    for (const s of sups) {
      await run(tx.insert(suppressionsTable).values(suppressionToRow(s)));
    }
  });
}

export function isActiveSuppression(s: Pick<Suppression, 'expiresAt'>): boolean {
  return !s.expiresAt || new Date(s.expiresAt) > new Date();
}

// --- helpers ---

type Row = typeof suppressionsTable.$inferSelect;

function rowToSuppression(row: Row): Suppression {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    resourceId: row.resourceId ?? undefined,
    reason: row.reason,
    suppressedAt: row.suppressedAt,
    ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
  };
}

function suppressionToRow(s: Suppression): typeof suppressionsTable.$inferInsert {
  return {
    id: s.id,
    fingerprint: s.fingerprint,
    resourceId: s.resourceId ?? null,
    reason: s.reason,
    suppressedAt: s.suppressedAt,
    expiresAt: s.expiresAt ?? null,
  };
}
