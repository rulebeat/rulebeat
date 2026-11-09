/**
 * What the `subscription=` and `rg=` of an old `/scans` link mean for one viewer (ADR 0015). The conversion
 * mapping that upgrades stored filters reads the values into Scope picks, and the viewer's Access narrows the
 * result: a value counts as translated only when it reaches a pick the viewer holds, a name-only resource group
 * resolves only to the pairs they hold, and a value that reaches none matches nothing and is counted as outside
 * their access, never written out as a pick. Pure: the pairs on record come in as an index.
 */
import { accessReach, type Access } from './access-model';
import { resolveLegacyScope, type indexPairs } from './db/filter-conversion';
import { DIRECTORY_SUBSCRIPTION } from './placement';
import { classifyPick, picksAsAccess, readPicks } from './scope-picks';
import { isUnresolvedPick } from './unresolved-pick';
import { NOTHING_OUTSIDE, type OutsideAccess } from './outside-access';

export interface LegacyScopeValues {
  subscriptions: readonly string[];
  resourceGroups: readonly string[];
}

export interface LegacyScopeTranslation {
  /** The Scope picks the held values translate to: only pairs the viewer holds, in the order the mapping gives. */
  paths: string[];
  /** The values that reach none of them, as the link wrote them, when the viewer holds less than Everything: they
   *  are counted as outside the viewer's access and never named. */
  outside: OutsideAccess;
  /** The same values for Everything, who holds every pair: a name no record pairs with a subscription. They stay
   *  named, marked as no longer existing. */
  gone: OutsideAccess;
  /** Every value reached a pick the viewer holds, so the link can be written in full as Scope picks. */
  complete: boolean;
}

/** A pick is held when the viewer holds all of it or, for a subscription, a part of it: ADR 0015 applies the part. */
function holds(access: Access, path: string): boolean {
  if (isUnresolvedPick(path)) return false;
  const state = classifyPick(access, path, []);
  return state === 'held' || state === 'narrowed';
}

export function translateLegacyScope(
  access: Access, values: LegacyScopeValues, pairs: ReturnType<typeof indexPairs>,
): LegacyScopeTranslation {
  const paths = resolveLegacyScope(values.subscriptions, values.resourceGroups, pairs).paths.filter(path => holds(access, path));
  const reached = accessReach(picksAsAccess(readPicks(paths), []));
  const subscriptions = new Set([...reached.subscriptions, ...reached.resourceGroups.keys(), ...(reached.directory ? [DIRECTORY_SUBSCRIPTION] : [])]);
  const groups = new Set([...reached.resourceGroups.values()].flatMap(names => [...names]));

  const unmatched: OutsideAccess = {
    subscriptions: values.subscriptions.filter(value => !subscriptions.has(value.toLowerCase())),
    resourceGroups: values.resourceGroups.filter(value => !groups.has(value.toLowerCase())),
  };
  const none = unmatched.subscriptions.length === 0 && unmatched.resourceGroups.length === 0;
  return {
    paths,
    outside: access.everything ? NOTHING_OUTSIDE : unmatched,
    gone: access.everything ? unmatched : NOTHING_OUTSIDE,
    complete: paths.length > 0 && none,
  };
}
