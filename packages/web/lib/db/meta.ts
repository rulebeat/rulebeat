import { eq } from 'drizzle-orm';
import { db } from './client';
import { dbKind } from './backend';
import { meta as metaTable } from './tables';
import { one, run } from './exec';

export async function getMeta(key: string): Promise<string | null> {
  const row = await one(db.select().from(metaTable).where(eq(metaTable.key, key)));
  return row?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await run(
    db.insert(metaTable).values({ key, value })
      .onConflictDoUpdate({ target: metaTable.key, set: { value } }),
  );
}

export async function deleteMeta(key: string): Promise<void> {
  await run(db.delete(metaTable).where(eq(metaTable.key, key)));
}

// --- Temporary SQLite-only synchronous variants (issue #73 Phase 0) -----------------------------
//
// The spike ports only the meta/findings/notification repositories to the async dual-backend
// style. Some meta callers sit in call chains that are still synchronous end to end and whose
// conversion would drag most of the auth surface into the spike: demo.ts's isDemoMode (memoised,
// checked on every guarded request), sign-in-config.ts (whose callers reach auth.ts, api-auth.ts
// and the scheduler), onboarding.ts, and snapshots.ts. Those keep using these sync variants until
// the Phase 2 sweep converts them and deletes this block. They throw on Postgres so a
// not-yet-ported caller fails loudly there instead of misbehaving.

function assertSqlite(fnName: string): void {
  if (dbKind !== 'sqlite') {
    throw new Error(
      `${fnName} is SQLite-only until the issue #73 Phase 2 async sweep; this caller cannot run against Postgres yet.`,
    );
  }
}

export function getMetaSync(key: string): string | null {
  assertSqlite('getMetaSync');
  const row = db.select().from(metaTable).where(eq(metaTable.key, key)).get();
  return row?.value ?? null;
}

export function setMetaSync(key: string, value: string): void {
  assertSqlite('setMetaSync');
  db.insert(metaTable).values({ key, value })
    .onConflictDoUpdate({ target: metaTable.key, set: { value } })
    .run();
}

export function deleteMetaSync(key: string): void {
  assertSqlite('deleteMetaSync');
  db.delete(metaTable).where(eq(metaTable.key, key)).run();
}
