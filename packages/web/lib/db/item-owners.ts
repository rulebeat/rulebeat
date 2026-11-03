import { inArray } from 'drizzle-orm';
import { db } from './client';
import { users } from './tables';
import { many, type DbHandle } from './exec';
import type { ItemOwner, ItemVisibility } from '@/lib/types';
import { chunk } from './chunk';

/**
 * The Owners (ADR 0012) of the rows just read, by person id. An id with no `users` row (the person was
 * removed, or the column holds nothing) is simply absent, so the item reads as having no Owner. The
 * display name is the person's name where they have one and their email until they first sign in.
 */
export async function loadItemOwners(ownerIds: Iterable<string | null>, handle: DbHandle = db): Promise<Map<string, ItemOwner>> {
  const wanted = [...new Set([...ownerIds].filter((id): id is string => !!id))];
  const owners = new Map<string, ItemOwner>();
  for (const ids of chunk(wanted)) {
    const rows = await many(handle.select({ id: users.id, name: users.name, email: users.email })
      .from(users).where(inArray(users.id, ids)));
    for (const row of rows) owners.set(row.id, { id: row.id, displayName: row.name || row.email, email: row.email });
  }
  return owners;
}

/** `visibility` as stored. A value other than 'shared' reads as Personal, so a row written some other way never widens who sees it. */
export const readVisibility = (value: string): ItemVisibility => (value === 'shared' ? 'shared' : 'personal');
