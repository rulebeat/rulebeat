import { createHash } from 'node:crypto';
import type { Access } from './access-model';
import { EVERYTHING_COVERED, coveredScopeKey, labelCoveredScope, type CoveredEntry, type CoveredScopeView } from './run-scope';

/**
 * The covered Scope of a stored run as a person is told it: each entry labelled for their own access,
 * and a key that is equal for two runs that covered the same Scopes. The key is a hash, since the
 * normalised Scopes it stands for carry subscription ids a Viewer may not read.
 */
export function viewCoveredScope(entries: readonly CoveredEntry[], access: Access): CoveredScopeView {
  return {
    key: createHash('sha256').update(coveredScopeKey(entries)).digest('hex'),
    entries: labelCoveredScope(entries, access),
  };
}

/** What a run records on its row: JSON of `{ tenantId, path }` entries. */
export function serializeCoveredScope(entries: readonly CoveredEntry[] = EVERYTHING_COVERED): string {
  return JSON.stringify(entries.map(({ tenantId, path }) => ({ tenantId, path })));
}

/**
 * A row's covered Scope. NULL is Everything: no run was narrowed before the column existed, so a row
 * from before it covered Everything and nothing was backfilled. A value that cannot be read covers nothing.
 */
export function parseCoveredScope(stored: string | null | undefined): CoveredEntry[] {
  if (stored === null || stored === undefined) return [...EVERYTHING_COVERED];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): CoveredEntry[] => {
      const e = item as { tenantId?: unknown; path?: unknown };
      return typeof e?.path === 'string' ? [{ tenantId: typeof e.tenantId === 'string' ? e.tenantId : '', path: e.path }] : [];
    });
  } catch {
    return [];
  }
}
