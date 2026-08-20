import { eq } from 'drizzle-orm';
import { db } from './client';
import { meta as metaTable } from './schema';

export function getMeta(key: string): string | null {
  const row = db.select().from(metaTable).where(eq(metaTable.key, key)).get();
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  db.insert(metaTable).values({ key, value })
    .onConflictDoUpdate({ target: metaTable.key, set: { value } })
    .run();
}

export function deleteMeta(key: string): void {
  db.delete(metaTable).where(eq(metaTable.key, key)).run();
}
