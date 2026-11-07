/**
 * Scope sets (ADR 0016): what may go into one, and the hash that names it. Server-side only, since the
 * hash is computed with `node:crypto` and a client's own value is never trusted. The row itself is in
 * `lib/db/scope-sets.ts`.
 */
import { createHash } from 'node:crypto';
import { grantCovers, parseScope, type Access, type ScopeKind } from './access-model';

/** The most paths a caller may send in one set. A set the server builds itself is not held to it. */
export const SCOPE_SET_MAX_PATHS = 2000;

/** The largest request body `POST /api/scope-sets` reads. 2000 resource group paths are about 300 KB. */
export const SCOPE_SET_MAX_BODY_BYTES = 1024 * 1024;

/** The Scopes a set may hold. Everything is no pick, so it is not one. */
const SET_KINDS: readonly ScopeKind[] = ['managementGroup', 'subscription', 'resourceGroup', 'directory'];

/** `list` without repeats that differ only by case, the first spelling kept. */
export function distinctPaths(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of list) {
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

/**
 * The name of a set: the sha256 of the sorted, de-duplicated, lower-cased path list, written as a JSON
 * array so no path can run into the next. Two lists that differ only in order or casing are one set.
 */
export function scopeSetHash(paths: readonly string[]): string {
  const canonical = distinctPaths(paths.map(path => path.toLowerCase())).sort();
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export type ScopeSetShape =
  | { ok: true; paths: string[] }
  | { ok: false; reason: 'malformed' | 'too-many' };

/**
 * Whether a request's `paths` is a list of one or more Scopes `parseScope` reads as a management group, a
 * subscription, a resource group or the Directory, at most `SCOPE_SET_MAX_PATHS` of them once repeats are
 * dropped (`cap: false` lifts that, for a set the server builds itself). The paths come back as sent.
 */
export function checkScopeSetShape(input: unknown, options: { cap?: boolean } = {}): ScopeSetShape {
  const cap = options.cap ?? true;
  if (!Array.isArray(input) || input.length === 0) return { ok: false, reason: 'malformed' };
  // A list far over the cap is refused before any path is read.
  if (cap && input.length > SCOPE_SET_MAX_PATHS * 10) return { ok: false, reason: 'too-many' };
  for (const path of input) {
    const scope = typeof path === 'string' ? parseScope(path) : null;
    if (!scope || !SET_KINDS.includes(scope.kind)) return { ok: false, reason: 'malformed' };
  }
  const paths = input as string[];
  if (cap && distinctPaths(paths).length > SCOPE_SET_MAX_PATHS) return { ok: false, reason: 'too-many' };
  return { ok: true, paths };
}

/**
 * The paths of `paths` the caller does not hold, and that are not among `alreadyStored`. Everything holds
 * every path. A save route passes the set already on the row it is saving as `alreadyStored`, so a person
 * who edits another field of a shared view is not asked to hold what its author held.
 */
export function pathsOutsideAccess(access: Access, paths: readonly string[], alreadyStored: readonly string[] = []): string[] {
  if (access.everything) return [];
  const stored = new Set(alreadyStored.map(path => path.toLowerCase()));
  return paths.filter(path => {
    if (stored.has(path.toLowerCase())) return false;
    const scope = parseScope(path);
    return !scope || !access.grants.some(grant => grantCovers(access, grant, scope));
  });
}
