import { db } from './db/client';
import { suppressions as suppressionsTable } from './db/tables';
import { many, run, inTransaction } from './db/exec';
import type { Suppression } from './types';

export async function loadSuppressions(): Promise<Suppression[]> {
  return (await many(db.select().from(suppressionsTable))).map(rowToSuppression);
}

export async function saveSuppressions(sups: Suppression[]): Promise<void> {
  await inTransaction(async (tx) => {
    await run(tx.delete(suppressionsTable));
    for (const s of sups) {
      await run(tx.insert(suppressionsTable).values(suppressionToRow(s)));
    }
  });
}

export function isActiveSuppression(s: Suppression): boolean {
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
