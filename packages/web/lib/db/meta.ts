import { eq } from 'drizzle-orm';
import { db } from './client';
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
