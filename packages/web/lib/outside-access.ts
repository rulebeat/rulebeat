/**
 * Which values of the Scans address a person's access does not reach (#274). The explorer's own filters
 * (the URL's `subscription` and `rg`) can name a subscription or a resource group the person holds no Scope
 * in. The page still opens, and the filter reads "Outside your access" where it would name the value,
 * because the id or the name of something they cannot see is not theirs to read.
 *
 * The marks are a list beside the filter, never a change to it. What a dashboard or a saved view stores is
 * not marked here: those values leave the server only as counts (lib/held-back.ts). Pure and client-safe,
 * like `lib/access-model.ts`.
 */
import { DIRECTORY_SUBSCRIPTION } from './placement';
import { wholeSubscriptionIds, type Access } from './access-model';
import { OUTSIDE_ACCESS_LABEL } from './held-back';

/** The address values, as written, that sit outside a person's access. */
export interface OutsideAccess {
  subscriptions: string[];
  resourceGroups: string[];
}

export const NOTHING_OUTSIDE: OutsideAccess = Object.freeze({
  subscriptions: Object.freeze([]) as unknown as string[],
  resourceGroups: Object.freeze([]) as unknown as string[],
});

export type OutsideDimension = 'subscription' | 'resourceGroup';

/** The two dimensions of a filter that access can put a value outside of. Every other filter is never marked. */
export interface AccessFilterValues {
  subscriptions?: readonly string[];
  resourceGroups?: readonly string[];
}

/**
 * The values of `filter` outside `access`:
 *
 *  - A subscription value is outside when the person holds neither that subscription (directly or under a
 *    management group) nor any resource group in it. The reserved Directory value is outside without the
 *    Directory Scope.
 *  - A resource group name is outside when the person holds no whole subscription and no resource group
 *    Scope of that name. A name is not tied to a subscription, so a whole subscription is enough to cover it.
 *
 * Comparison ignores case, and each mark is the value as it was stored. Everything has none.
 */
export function markOutsideAccess(access: Access, filter: AccessFilterValues): OutsideAccess {
  if (access.everything) return { subscriptions: [], resourceGroups: [] };

  const whole = new Set(wholeSubscriptionIds(access));
  const subscriptionsWithGroup = new Set<string>();
  const groupNames = new Set<string>();
  for (const { scope } of access.grants) {
    if (scope.kind !== 'resourceGroup') continue;
    const parts = scope.path.split('/');
    subscriptionsWithGroup.add(parts[2]!.toLowerCase());
    groupNames.add(parts[4]!.toLowerCase());
  }

  const subscriptions = (filter.subscriptions ?? []).filter(value => {
    const key = value.toLowerCase();
    if (key === DIRECTORY_SUBSCRIPTION) return !access.directory;
    return !whole.has(key) && !subscriptionsWithGroup.has(key);
  });
  const resourceGroups = (filter.resourceGroups ?? []).filter(value => whole.size === 0 && !groupNames.has(value.toLowerCase()));
  return { subscriptions: unique(subscriptions), resourceGroups: unique(resourceGroups) };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** Whether `value` of a dimension is one of the marks. Ignores case, like the marks themselves. */
export function isOutsideAccess(marks: OutsideAccess | undefined, dimension: OutsideDimension, value: string): boolean {
  const list = dimension === 'subscription' ? marks?.subscriptions : marks?.resourceGroups;
  const key = value.toLowerCase();
  return (list ?? []).some(marked => marked.toLowerCase() === key);
}

/** What an address value reads as: the label for a mark, else `named(value)`. */
export function outsideAwareLabel(
  marks: OutsideAccess | undefined, dimension: OutsideDimension, value: string, named: (value: string) => string,
): string {
  return isOutsideAccess(marks, dimension, value) ? OUTSIDE_ACCESS_LABEL : named(value);
}

/**
 * Which dimension, if any, leaves a filter with nothing the person can see: every subscription value in
 * it is marked, or every resource group value is. An empty list names nothing, so it never does.
 */
export function filterOutsideDimension(filter: AccessFilterValues, marks: OutsideAccess | undefined): OutsideDimension | null {
  const allOutside = (dimension: OutsideDimension, values: readonly string[] | undefined) =>
    Boolean(values?.length) && values!.every(value => isOutsideAccess(marks, dimension, value));
  if (allOutside('subscription', filter.subscriptions)) return 'subscription';
  if (allOutside('resourceGroup', filter.resourceGroups)) return 'resourceGroup';
  return null;
}
