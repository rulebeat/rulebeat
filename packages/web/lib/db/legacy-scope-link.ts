import type { Access } from '@/lib/access-model';
import type { DbHandle } from '@/lib/db/exec';
import { filterValues, hasScopeParam, legacyScopeValues, replaceLegacyScope, scopeFitsInline, type View } from '@/lib/finding-view';
import { NOTHING_OUTSIDE, type OutsideAccess } from '@/lib/outside-access';
import { translateLegacyScope } from '@/lib/legacy-scope';
import { readRecordedPairs, readRecordedPairsOn } from '@/lib/db/filter-pairs';
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

  const translation = translateLegacyScope(access, values, await readRecordedPairs(access));
  if (!translation.complete) return null;

  const written = scopeFitsInline(translation.paths)
    ? { paths: translation.paths }
    : { scopeSet: (await createScopeSet(translation.paths)).hash };
  return `/scans?${replaceLegacyScope(params, written).toString()}`;
}

/**
 * The subscription and resource group values of `view`'s filters that reach no pair `access` holds: they match
 * nothing, and the explorer counts them as outside the viewer's access without naming them. Only an old link
 * puts these values in a filter. Everything holds every pair, so a value no record pairs with a subscription is
 * a plain empty filter for them and marks nothing.
 */
export async function legacyOutsideAccess(tx: DbHandle, view: View, access: Access): Promise<OutsideAccess> {
  const values = { subscriptions: filterValues(view.filters, 'subscription'), resourceGroups: filterValues(view.filters, 'resourceGroup') };
  if (access.everything || (values.subscriptions.length === 0 && values.resourceGroups.length === 0)) return NOTHING_OUTSIDE;
  return translateLegacyScope(access, values, await readRecordedPairsOn(tx, access)).outside;
}
