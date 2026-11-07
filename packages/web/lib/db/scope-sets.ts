import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { scopeSets } from '@/lib/db/tables';
import { one, run, type DbHandle } from '@/lib/db/exec';
import { isUnresolvedPick } from '@/lib/unresolved-pick';
import { checkScopeSetShape, distinctPaths, scopeSetHash } from '@/lib/scope-sets';

/**
 * Scope sets (ADR 0016): immutable, content-addressed rows holding a long Scope list. A row is never
 * updated or deleted, so writing the same list twice is one row and the first casing written stays.
 */

const SHA256 = /^[0-9a-f]{64}$/;

export interface ScopeSetRef {
  hash: string;
  /** The paths as stored, in the casing first written. */
  paths: string[];
}

/**
 * Stores the list and answers with the server's own hash for it. This is the path the conversion, link
 * building and old-link translation take, so it neither checks what the caller holds nor caps the list;
 * `POST /api/scope-sets` does both before it calls this. A path that is not a managementGroup,
 * subscription, resourceGroup or directory Scope throws: it is a bug in the caller, not a request.
 * `unresolved: true` lets the list also hold unresolved picks (lib/unresolved-pick.ts), which only the
 * conversion of an old filter writes: they match nothing and keep the old filter's own words visible.
 */
export async function createScopeSet(paths: readonly string[], options: { unresolved?: boolean } = {}): Promise<ScopeSetRef> {
  const real = options.unresolved ? paths.filter(p => !isUnresolvedPick(p)) : paths;
  const fits = options.unresolved && real.length === 0 ? paths.length > 0 : checkScopeSetShape(real, { cap: false }).ok;
  if (!fits) throw new Error('A scope set holds one or more management group, subscription, resource group or Directory paths.');
  const hash = scopeSetHash(paths);
  await run(db.insert(scopeSets)
    .values({ hash, paths: JSON.stringify(distinctPaths(paths)), createdAt: new Date().toISOString() })
    .onConflictDoNothing({ target: scopeSets.hash }));
  const stored = await expandScopeSet(hash);
  if (stored.status !== 'resolved') throw new Error('A scope set was written and cannot be read back.');
  return { hash, paths: stored.paths };
}

export type ScopeSetExpansion =
  | { status: 'resolved'; paths: string[] }
  /** No row has this hash: it came from another install, or the database was restored from before it. */
  | { status: 'unresolved' };

/** The stored paths for a hash, or `unresolved`. Never an empty list, which would read as no pick. */
export function expandScopeSet(hash: string): Promise<ScopeSetExpansion> {
  return expandScopeSetOn(db, hash);
}

/** `expandScopeSet` on a handle: a view read opens its set inside its own transaction. */
export async function expandScopeSetOn(tx: DbHandle, hash: string): Promise<ScopeSetExpansion> {
  const key = hash.toLowerCase();
  if (!SHA256.test(key)) return { status: 'unresolved' };
  const row = await one(tx.select().from(scopeSets).where(eq(scopeSets.hash, key)));
  if (!row) return { status: 'unresolved' };
  try {
    const paths: unknown = JSON.parse(row.paths);
    if (Array.isArray(paths) && paths.length > 0 && paths.every(p => typeof p === 'string')) return { status: 'resolved', paths };
  } catch { /* an unreadable row is no better than a missing one */ }
  return { status: 'unresolved' };
}
