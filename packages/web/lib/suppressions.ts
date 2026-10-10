import { eq } from 'drizzle-orm';
import { db } from './db/client';
import { suppressions as suppressionsTable } from './db/tables';
import { many, one, run, inTransaction } from './db/exec';
import type { Suppression } from './types';

export async function loadSuppressions(): Promise<Suppression[]> {
  return (await many(db.select().from(suppressionsTable))).map(rowToSuppression);
}

/** Inserts one suppression without touching the others, so two people suppressing at once both land. */
export async function addSuppression(s: Suppression): Promise<void> {
  await run(db.insert(suppressionsTable).values(suppressionToRow(s)));
}

/** Deletes one suppression by id. Returns the removed suppression, or null if there was none. */
export async function removeSuppression(id: string): Promise<Suppression | null> {
  return inTransaction(async (tx) => {
    const row = await one(tx.select().from(suppressionsTable).where(eq(suppressionsTable.id, id)));
    if (!row) return null;
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
