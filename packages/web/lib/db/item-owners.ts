import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './client';
import { dashboards, savedViews, users } from './tables';
import { many, run, type DbHandle } from './exec';
import type { ItemOwner, ItemVisibility } from '@/lib/types';
import { chunk } from './chunk';
import type { OwnedItemCounts } from '@/lib/owned-items-copy';

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

/** What each person owns, by person id. A person who owns nothing is absent. */
export async function countOwnedItemsByPerson(handle: DbHandle = db): Promise<Record<string, OwnedItemCounts>> {
  const byPerson: Record<string, OwnedItemCounts> = {};
  const add = (ownerId: string | null, visibility: string, personal: keyof OwnedItemCounts, shared: keyof OwnedItemCounts, count: number) => {
    if (!ownerId) return;
    byPerson[ownerId] ??= { personalDashboards: 0, sharedDashboards: 0, personalViews: 0, sharedViews: 0 };
    byPerson[ownerId][readVisibility(visibility) === 'shared' ? shared : personal] += count;
  };
  for (const row of await many(handle.select({ ownerId: dashboards.ownerId, visibility: dashboards.visibility, count: sql<number>`count(*)` })
    .from(dashboards).groupBy(dashboards.ownerId, dashboards.visibility))) {
    add(row.ownerId, row.visibility, 'personalDashboards', 'sharedDashboards', Number(row.count));
  }
  for (const row of await many(handle.select({ ownerId: savedViews.ownerId, visibility: savedViews.visibility, count: sql<number>`count(*)` })
    .from(savedViews).groupBy(savedViews.ownerId, savedViews.visibility))) {
    add(row.ownerId, row.visibility, 'personalViews', 'sharedViews', Number(row.count));
  }
  return byPerson;
}

export async function countOwnedItems(ownerId: string, handle: DbHandle = db): Promise<OwnedItemCounts> {
  return (await countOwnedItemsByPerson(handle))[ownerId] ?? { personalDashboards: 0, sharedDashboards: 0, personalViews: 0, sharedViews: 0 };
}

/** What removing a person did to their items: Personal ones deleted, Shared ones left with no owner. */
export interface OwnedItemsRemoved {
  dashboards: { deleted: number; released: number };
  views: { deleted: number; released: number };
}

/**
 * Takes a person's items with them, on `tx` (the user delete's transaction): their Personal dashboards and
 * saved views are deleted, and their Shared ones stay Shared with no owner. Returns the counts, nothing else.
 */
export async function releaseOwnedItemsOn(tx: DbHandle, ownerId: string): Promise<OwnedItemsRemoved> {
  const counts = await countOwnedItems(ownerId, tx);
  await run(tx.delete(dashboards).where(and(eq(dashboards.ownerId, ownerId), eq(dashboards.visibility, 'personal'))));
  await run(tx.update(dashboards).set({ ownerId: null, revision: sql`${dashboards.revision} + 1` }).where(eq(dashboards.ownerId, ownerId)));
  await run(tx.delete(savedViews).where(and(eq(savedViews.ownerId, ownerId), eq(savedViews.visibility, 'personal'))));
  await run(tx.update(savedViews).set({ ownerId: null, revision: sql`${savedViews.revision} + 1` }).where(eq(savedViews.ownerId, ownerId)));
  return {
    dashboards: { deleted: counts.personalDashboards, released: counts.sharedDashboards },
    views: { deleted: counts.personalViews, released: counts.sharedViews },
  };
}
