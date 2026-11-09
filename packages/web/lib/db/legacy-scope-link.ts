import type { Access } from '@/lib/access-model';
import type { DbHandle } from '@/lib/db/exec';
import { filterValues, hasScopeParam, legacyScopeValues, replaceLegacyScope, scopeFitsInline, type View } from '@/lib/finding-view';
import { NOTHING_OUTSIDE, type OutsideAccess } from '@/lib/outside-access';
import { translateLegacyScope, type LegacyScopeValues } from '@/lib/legacy-scope';
import { readRecordedPairs, readRecordedPairsOn } from '@/lib/db/filter-pairs';
import { indexPairs } from '@/lib/db/filter-conversion';
import { createScopeSet } from '@/lib/db/scope-sets';

/**
 * Where an old `/scans` link that carries `subscription=` and `rg=` should go (#392), or null when its address is
 * right as it is. The values are translated with the conversion mapping and narrowed to `access`: a name-only
 * resource group resolves only to the pairs the viewer holds. When every value reaches a held pair the address is
 * replaced in full with the new encoding, a long result as a Scope set of the held pairs. A value that reaches none
 * keeps the whole address as it was: it matches nothing, the view counts it as outside the viewer's access, and it
 * is never written out as a pick. An address that already holds a Scope is not an old link.
 */
export async function legacyLinkRedirect(
  params: Record<string, string | string[] | undefined>, access: Access,
): Promise<string | null> {
  const values = legacyScopeValues(params);
  if (values.subscriptions.length === 0 && values.resourceGroups.length === 0) return null;
  if (hasScopeParam(params)) return null;

  const translation = translateLegacyScope(access, values, await pairsFor(access, values, readRecordedPairs));
  if (!translation.complete) return null;

  const written = scopeFitsInline(translation.paths)
    ? { paths: translation.paths }
    : { scopeSet: (await createScopeSet(translation.paths)).hash };
  return `/scans?${replaceLegacyScope(params, written).toString()}`;
}

/** The pairs on record, read only when a name-only resource group needs them: a resource group name with no
 *  subscription beside it is the one value whose pairs are not in the link. */
function pairsFor(access: Access, values: LegacyScopeValues, read: (access: Access) => Promise<ReturnType<typeof indexPairs>>) {
  const nameOnly = values.subscriptions.length === 0 && values.resourceGroups.length > 0;
  return nameOnly ? read(access) : Promise.resolve(indexPairs([]));
}

export interface LegacyResolution {
  /** `view` without its subscription and resource group filters, which `paths` stand for. */
  view: View;
  /** The held pairs the view's old filters translate to, which the findings must also be inside, or null when the
   *  view has no such filter. An empty list matches nothing. */
  paths: string[] | null;
  /** The values that reach no pair a viewer holding less than Everything holds: counted, never named. */
  outside: OutsideAccess;
  /** The same for Everything: values no record pairs with a subscription, named and marked as no longer existing. */
  gone: OutsideAccess;
}

const NO_LEGACY: Pick<LegacyResolution, 'paths' | 'outside' | 'gone'> = { paths: null, outside: NOTHING_OUTSIDE, gone: NOTHING_OUTSIDE };

/**
 * What the subscription and resource group filters of `view` mean for `access`. Only an old link puts these values
 * in a filter, and they match the way their translation does, as Scope picks: a value that reaches a held pair
 * matches that pair (whatever its case), one that reaches none matches nothing, and a name-only resource group
 * resolves only to the pairs the viewer holds. The values come out of the view's filters so nothing downstream
 * matches them by exact string.
 */
export async function resolveLegacyFilters(tx: DbHandle, view: View, access: Access): Promise<LegacyResolution> {
  const values = { subscriptions: filterValues(view.filters, 'subscription'), resourceGroups: filterValues(view.filters, 'resourceGroup') };
  if (values.subscriptions.length === 0 && values.resourceGroups.length === 0) return { view, ...NO_LEGACY };
  const { paths, outside, gone } = translateLegacyScope(access, values, await pairsFor(access, values, a => readRecordedPairsOn(tx, a)));
  const filters = view.filters.filter(f => f.field !== 'subscription' && f.field !== 'resourceGroup');
  return { view: { ...view, filters }, paths, outside, gone };
}

/**
 * Saved views as the routes return them: each stored view unchanged, plus the values of its old subscription and
 * resource group filters that reach no pair `access` holds. A view the upgrade converted keeps those values beside
 * its Scope picks, and they are read on Scans the way this reads them, by held pairs, so the badge and the list
 * cannot disagree. The recorded pairs are read once, and only for a view that names a resource group on its own.
 */
export async function markedSavedViews<T extends { query: string }>(
  access: Access, views: readonly T[],
): Promise<(T & { outsideAccess: OutsideAccess })[]> {
  const read = views.map(view => ({ view, values: legacyScopeValues(new URLSearchParams(view.query)) }));
  const needsPairs = !access.everything && read.some(r => r.values.subscriptions.length === 0 && r.values.resourceGroups.length > 0);
  const pairs = needsPairs ? await readRecordedPairs(access) : indexPairs([]);
  return read.map(({ view, values }) => ({ ...view, outsideAccess: translateLegacyScope(access, values, pairs).outside }));
}

/** `markedSavedViews` for one saved view. */
export async function markedSavedView<T extends { query: string }>(access: Access, view: T): Promise<T & { outsideAccess: OutsideAccess }> {
  return (await markedSavedViews(access, [view]))[0]!;
}
