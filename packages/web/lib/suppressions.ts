import { db } from './db/client';
import { suppressions as suppressionsTable } from './db/schema';
import type { Suppression } from './types';

export function loadSuppressions(): Suppression[] {
  return db.select().from(suppressionsTable).all().map(rowToSuppression);
}

export function saveSuppressions(sups: Suppression[]): void {
  db.transaction((tx) => {
    tx.delete(suppressionsTable).run();
    for (const s of sups) {
      tx.insert(suppressionsTable).values(suppressionToRow(s)).run();
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
