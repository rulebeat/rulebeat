/**
 * What the dashboard and saved view save routes do with a Scope filter before it is stored (ADR 0015, 0016).
 * They write only the new shape, and hold a person to the Scopes they add: a path already on the row being
 * saved is not asked for again, so an Editor who changes another field of a shared dashboard or saved view is
 * not refused for what its author held.
 */
import { parseScope, type Access } from '@/lib/access-model';
import { viewFromSearchParams } from '@/lib/finding-view';
import { isUnresolvedPick } from '@/lib/unresolved-pick';
import { pathsOutsideAccess } from '@/lib/scope-sets';
import { MAX_SAVED_VIEW_QUERY_LENGTH, normalizeViewQuery } from '@/lib/saved-view-query';
import { convertDashboardConfig, convertSavedViewQuery, legacyFiltersOf, sameLegacy } from '@/lib/db/filter-conversion';
import { readRecordedPairs } from '@/lib/db/filter-pairs';
import { createScopeSet, expandScopeSet } from '@/lib/db/scope-sets';
import type { DashboardConfig, DashboardDimensionFilters, LegacyDashboardFilters } from '@/lib/types';

export const OUTSIDE_ACCESS_ERROR = 'A path in the list is outside the Scopes you hold.';
const MALFORMED_SCOPE_ERROR = 'A Scope pick is a management group, subscription, resource group or Directory path.';
const UNKNOWN_SET_ERROR = 'The Scope list is not one this install made. Send its paths again.';

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const SHA256 = /^[0-9a-f]{64}$/i;

/** The paths a stored or sent pick list and set stand for. `null` for a set this install cannot open. */
async function pathsOf(scope: readonly string[] | undefined, scopeSet: string | undefined): Promise<string[] | null> {
  const paths = (scope ?? []).filter(p => !isUnresolvedPick(p));
  if (scopeSet === undefined) return paths;
  const expansion = await expandScopeSet(scopeSet);
  return expansion.status === 'resolved' ? [...paths, ...expansion.paths.filter(p => !isUnresolvedPick(p))] : null;
}

/**
 * Whether `access` may add the Scopes of `scope` and `scopeSet`, leaving out those `stored` already held. A set
 * a client names must be one this install holds a row for; the same hash already stored needs no row to be kept.
 */
async function checkAdded(
  access: Access,
  sent: { scope?: readonly string[]; scopeSet?: string },
  stored: { scope?: readonly string[]; scopeSet?: string },
): Promise<string | null> {
  const unchangedSet = sent.scopeSet !== undefined && sent.scopeSet.toLowerCase() === stored.scopeSet?.toLowerCase();
  const sentPaths = await pathsOf(sent.scope, unchangedSet ? undefined : sent.scopeSet);
  if (sentPaths === null) return UNKNOWN_SET_ERROR;
  return checkAddedPaths(access, sentPaths, stored);
}

/** Whether `access` may add `sentPaths`, leaving out those `stored` already held. */
async function checkAddedPaths(
  access: Access, sentPaths: readonly string[], stored: { scope?: readonly string[]; scopeSet?: string },
): Promise<string | null> {
  if (sentPaths.length === 0) return null;
  const storedPaths = await pathsOf(stored.scope, stored.scopeSet) ?? [];
  return pathsOutsideAccess(access, sentPaths, storedPaths).length > 0 ? OUTSIDE_ACCESS_ERROR : null;
}

const strings = (list: unknown): string[] | undefined =>
  Array.isArray(list) && list.every(v => typeof v === 'string') ? list as string[] : undefined;

/** The dimensions as they may be stored, or the reason they may not. Lists that are not lists of text are refused. */
function readDimensions(input: unknown): Result<DashboardDimensionFilters> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'dimensionFilters must be an object.' };
  const raw = input as Record<string, unknown>;
  const out: DashboardDimensionFilters = {};
  for (const key of ['category', 'scope', 'source', 'tags', 'severity', 'rule'] as const) {
    if (raw[key] === undefined) continue;
    const list = strings(raw[key]);
    if (!list) return { ok: false, error: `dimensionFilters.${key} must be a list of text.` };
    (out as Record<string, unknown>)[key] = list;
  }
  if (out.scope?.some(p => !isUnresolvedPick(p) && (parseScope(p)?.kind ?? 'everything') === 'everything')) return { ok: false, error: MALFORMED_SCOPE_ERROR };
  if (raw.scopeSet !== undefined) {
    if (typeof raw.scopeSet !== 'string' || !SHA256.test(raw.scopeSet)) return { ok: false, error: 'dimensionFilters.scopeSet must be a sha256 hash.' };
    out.scopeSet = raw.scopeSet.toLowerCase();
  }
  if (raw.window !== undefined) out.window = raw.window as DashboardDimensionFilters['window'];
  return { ok: true, value: out };
}

/**
 * The config to store for a dashboard save. The dimensions are the body's, held to the Scopes it adds, else
 * the stored ones, so a save that only moves a widget keeps the filters. A body with no dimensions and old
 * filter lists that differ from the row's is the filter bar, which still speaks the old lists: they are
 * converted the way the upgrade converts them, and stored as the legacy values and the record of what the
 * dimensions came from too, since the dashboard still reads them and a rollback reads them. Otherwise the
 * legacy values and the record are the stored row's own, whatever the body says, so a rollback reads what it
 * read and the upgrade can tell a save under 0.13 from this release's.
 */
export async function prepareDashboardConfig(
  access: Access, sent: DashboardConfig, stored: DashboardConfig | null,
): Promise<Result<DashboardConfig>> {
  const { filters: _f, dateWindow: _w, windowDays: _d, convertedFrom: _c, dimensionFilters, ...rest } = sent;
  const config: DashboardConfig = { ...rest };
  if (stored) {
    if (stored.filters) config.filters = stored.filters;
    if (stored.dateWindow) config.dateWindow = stored.dateWindow;
    if (stored.windowDays !== undefined) config.windowDays = stored.windowDays;
    if (stored.convertedFrom) config.convertedFrom = stored.convertedFrom;
  }

  if (dimensionFilters === undefined) {
    const barLists = legacyFiltersOf(sent);
    if (!sameLegacy(barLists, legacyFiltersOf(stored ?? { widgets: [] }))) return convertBarLists(access, config, barLists, stored);
    if (stored?.dimensionFilters) config.dimensionFilters = stored.dimensionFilters;
    return { ok: true, value: config };
  }
  const dimensions = readDimensions(dimensionFilters);
  if (!dimensions.ok) return dimensions;
  const refused = await checkAdded(access, dimensions.value, stored?.dimensionFilters ?? {});
  if (refused) return { ok: false, error: refused };
  config.dimensionFilters = dimensions.value;
  return { ok: true, value: config };
}

/** `config` with the filter bar's old lists stored as dimensions, legacy values and record (see `prepareDashboardConfig`). */
async function convertBarLists(
  access: Access, config: DashboardConfig, lists: LegacyDashboardFilters, stored: DashboardConfig | null,
): Promise<Result<DashboardConfig>> {
  delete config.filters;
  delete config.dateWindow;
  delete config.windowDays;
  delete config.convertedFrom;
  Object.assign(config, lists, { convertedFrom: lists });
  const converted = convertDashboardConfig({ widgets: [], ...lists }, await readRecordedPairs(access));
  const dimensions = converted?.config.dimensionFilters ?? {};
  // The set is not stored yet, so the held check reads the paths the conversion made, not the hash. A refused
  // list leaves no row behind.
  const added = [...(dimensions.scope ?? []), ...(converted?.set?.paths ?? [])].filter(p => !isUnresolvedPick(p));
  const refused = await checkAddedPaths(access, added, stored?.dimensionFilters ?? {});
  if (refused) return { ok: false, error: refused };
  if (converted?.set) await createScopeSet(converted.set.paths, { unresolved: true });
  config.dimensionFilters = dimensions;
  return { ok: true, value: config };
}

/**
 * The query without `subscription=` and `rg=` when it holds a Scope. The upgrade leaves them beside the Scope it
 * made from them for a rollback, the Scans explorer sends every param it opened the view with, and a save writes
 * only the new shape.
 */
function withoutLegacyScopeParams(query: string): string {
  const params = new URLSearchParams(query);
  if (!(params.has('scope') || params.has('scopeset')) || !(params.has('subscription') || params.has('rg'))) return query;
  params.delete('subscription');
  params.delete('rg');
  return normalizeViewQuery(params.toString());
}

/**
 * The query to store for a saved view save: the subscription and resource group params of an old query
 * become Scope picks (beside a Scope they are dropped, not converted again), and the Scopes it adds are held to the
 * person, leaving out those the stored query already held.
 */
export async function prepareSavedViewQuery(
  access: Access, query: string, storedQuery: string | null,
): Promise<Result<string>> {
  let next = query;
  const converted = convertSavedViewQuery(query, await readRecordedPairs(access), false);
  if (converted === 'too-long') return { ok: false, error: `Query must be ${MAX_SAVED_VIEW_QUERY_LENGTH} characters or fewer.` };
  if (converted) {
    if (converted.set) await createScopeSet(converted.set.paths, { unresolved: true });
    next = normalizeViewQuery(converted.query);
    if (next.length > MAX_SAVED_VIEW_QUERY_LENGTH) return { ok: false, error: `Query must be ${MAX_SAVED_VIEW_QUERY_LENGTH} characters or fewer.` };
  } else {
    next = withoutLegacyScopeParams(query);
  }
  const sent = viewFromSearchParams(new URLSearchParams(next));
  const stored = storedQuery === null ? {} : viewFromSearchParams(new URLSearchParams(storedQuery));
  const refused = await checkAdded(access, sent, stored);
  if (refused) return { ok: false, error: refused };
  return { ok: true, value: next };
}
