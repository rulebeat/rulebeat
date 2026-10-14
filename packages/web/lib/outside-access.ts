/**
 * Which values a stored filter names that a person's access does not reach (#274). A saved view or a
 * dashboard is shared with everyone, so it can be filtered to a subscription or a resource group the
 * person holds no Scope in. It still opens, and the filter reads "Outside your access" where it would
 * name the value, because the id or the name of something they cannot see is not theirs to read.
 *
 * The marks are a list beside the stored filter, never a change to it: an Editor on Everything who saves
 * the filter again loses nothing. Pure and client-safe, like `lib/access-model.ts`, so the routes, the
 * dashboard page and the components share one definition.
 */
import { DIRECTORY_SUBSCRIPTION } from './placement';
import { filterValues, viewFromSearchParams } from './finding-view';
import { wholeSubscriptionIds, type Access } from './access-model';
import type { DashboardConfig } from './types';

/** What a filter chip or a select reads in place of a value outside the person's access. */
export const OUTSIDE_ACCESS_LABEL = 'Outside your access';

/** The stored values, as stored, that sit outside a person's access. */
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

/** What a stored value reads as: the label for a mark, else `named(value)`. */
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

/**
 * `options` with each selected value that is marked appended as "Outside your access". The option lists
 * come from what the person can see, so a stored value outside their access is in none of them, and
 * without this the control would count it in its badge and offer nothing to untick. The option's value is
 * the stored one, so unticking it removes it; the label never names it.
 */
export function withOutsideOptions(
  options: readonly { value: string; label: string }[],
  selected: readonly string[],
  marks: OutsideAccess | undefined,
  dimension: OutsideDimension,
): { value: string; label: string }[] {
  const have = new Set(options.map(o => o.value));
  const extra = selected
    .filter(value => isOutsideAccess(marks, dimension, value) && !have.has(value))
    .map(value => ({ value, label: OUTSIDE_ACCESS_LABEL }));
  return [...options, ...extra];
}

/** What a widget says in place of a number when every subscription (or every resource group) it is
 *  filtered to is outside the person's access. A posture of 100%, "No violations found" or "All rules
 *  passing" would claim something was checked and found clean, when nothing of it is theirs to see. */
export function widgetAccessReason(filter: AccessFilterValues, marks: OutsideAccess | undefined): { title: string; detail: string } | null {
  const dimension = filterOutsideDimension(filter, marks);
  if (!dimension) return null;
  return {
    title: OUTSIDE_ACCESS_LABEL,
    detail: dimension === 'subscription'
      ? 'This widget is filtered to subscriptions your Access does not include, so it has nothing to count for you. Clear the filter to see your own.'
      : 'This widget is filtered to resource groups your Access does not include, so it has nothing to count for you. Clear the filter to see your own.',
  };
}

/** The marks for a saved view's stored query, read the way the explorer reads it. */
export function markSavedViewQuery(access: Access, query: string): OutsideAccess {
  const { filters } = viewFromSearchParams(new URLSearchParams(query));
  return markOutsideAccess(access, {
    subscriptions: filterValues(filters, 'subscription'),
    resourceGroups: filterValues(filters, 'resourceGroup'),
  });
}

/** A dashboard as the routes and the page return it: the stored dashboard unchanged, plus its marks. */
export function markedDashboard<T extends { config: DashboardConfig }>(access: Access, dashboard: T): T & { outsideAccess: OutsideAccess } {
  return { ...dashboard, outsideAccess: markDashboardConfig(access, dashboard.config) };
}

/** A saved view as the routes return it: the stored view unchanged, plus its marks. */
export function markedSavedView<T extends { query: string }>(access: Access, view: T): T & { outsideAccess: OutsideAccess } {
  return { ...view, outsideAccess: markSavedViewQuery(access, view.query) };
}

/**
 * The marks for everything a dashboard stores: its filter bar and the override on each widget. A mark is
 * a value, not a place, so one list serves every consumer, whichever of them holds the value.
 */
export function markDashboardConfig(access: Access, config: DashboardConfig): OutsideAccess {
  const subscriptions: string[] = [...(config.filters?.subscriptions ?? [])];
  const resourceGroups: string[] = [...(config.filters?.resourceGroups ?? [])];
  for (const widget of config.widgets ?? []) {
    const override = widget.config ?? {};
    for (const [key, into] of [['subscriptions', subscriptions], ['resourceGroups', resourceGroups]] as const) {
      const value = override[key];
      if (Array.isArray(value)) into.push(...value.filter((v): v is string => typeof v === 'string'));
    }
  }
  return markOutsideAccess(access, { subscriptions, resourceGroups });
}
