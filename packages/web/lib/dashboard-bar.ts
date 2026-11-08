/**
 * What the dashboard filter bar shows and what a pick writes (ADR 0013). Pure and client-safe: the
 * dashboard page builds the state on the server from the saved filters, the changes in the address and
 * the viewer's Access, and the bar writes picks back to the address through the same functions.
 *
 * A value the viewer's Access does not reach is counted and never named. A pick never widens a
 * dimension: unticking the last visible value over held-back saved values is refused, and "any" is
 * only ever an explicit pick.
 */
import type { DateWindow } from './date-window';
import { applyChanges, overriddenDimensions, sameValues } from './dashboard-filters';
import { sameWindow, type DashboardFilterChanges, type DashboardFilters } from './finding-view';
import { isOutsideAccess, markOutsideAccess, type OutsideAccess } from './outside-access';
import type { Access } from './access-model';

export type BarListDimension = Exclude<keyof DashboardFilters, 'window'>;
export type BarDimension = keyof DashboardFilters;

export const BAR_LIST_DIMENSIONS: readonly BarListDimension[] = ['category', 'rule', 'subscription', 'resourceGroup', 'tags', 'severity'];

export const UNTICK_LAST_REASON = 'Removing it leaves only values outside your access';
export const ANY_WIDENS_REASON = 'Any widens this filter for everyone who opens the link, including values outside your access';
export const VANISHED_NOTE = 'No longer exists';
export const VANISHED_RULE_NOTE = 'A rule that no longer exists';

export interface VanishedValue {
  value: string;
  /** What the bar reads in place of the value. A deleted rule has no name left to show. */
  label: string;
  note: string;
}

export interface BarDimensionState {
  /** The values the viewer holds in the effective layer: the address when it sets the dimension, else the saved filters. */
  effective: string[];
  /** The saved values the viewer holds, for the "Saved: ..." line. */
  saved: string[];
  /** The address sets this dimension to something other than what is saved. */
  changed: boolean;
  /** The address sets this dimension at all. */
  inUrl: boolean;
  /** How many values outside the viewer's Access each layer holds. Only ever counts. */
  outside: { saved: number; url: number };
  /** The effective values that match nothing now. They stay in the dimension until someone removes them. */
  vanished: VanishedValue[];
  /** The same for the saved values the viewer holds, so the "Saved: ..." line marks them too. */
  savedVanished: VanishedValue[];
}

/** How a value that no longer exists reads: a deleted rule has no name left, any other keeps its own. */
export function vanishedText(vanished: VanishedValue, nameOf: (value: string) => string = v => v): string {
  return vanished.note === vanished.label ? vanished.label : `${nameOf(vanished.label)} (${vanished.note})`;
}

export interface DashboardBarState {
  /** The revision of the dashboard these numbers were computed from. */
  revision: number;
  dimensions: Record<BarListDimension, BarDimensionState>;
  window: { changed: boolean; saved: DateWindow; effective: DateWindow };
  /** How many widgets set their own value for each dimension, so the bar can say why a change does not reach them. */
  overriddenBy: Record<BarDimension, number>;
}

/** What exists now, per dimension. A dimension with no entry cannot be checked, so nothing in it is called gone. */
export interface KnownValues {
  category?: ReadonlySet<string>;
  rule?: ReadonlySet<string>;
  tags?: ReadonlySet<string>;
  subscription?: ReadonlySet<string>;
}

function inKnown(known: ReadonlySet<string>, value: string): boolean {
  const key = value.toLowerCase();
  return [...known].some(v => v.toLowerCase() === key);
}

/** Whether the server can say `value` no longer exists. A dimension it has no list for is never gone. */
function isGone(dim: BarListDimension, known: KnownValues, value: string): boolean {
  const values = dim === 'category' || dim === 'rule' || dim === 'tags' || dim === 'subscription' ? known[dim] : undefined;
  return values !== undefined && !inKnown(values, value);
}

export interface BuildBarStateInput {
  revision: number;
  saved: DashboardFilters;
  changes: DashboardFilterChanges;
  access: Access;
  /** The dashboard's widgets, for the ones that override a dimension. */
  widgets: readonly { config?: Record<string, unknown> }[];
  known?: KnownValues;
}

/**
 * The bar's state for one viewer, and the marks a pick writes by: every subscription and resource group
 * value in the saved filters, the address and the widgets that the viewer cannot use. The state names
 * only what the viewer holds.
 */
export function buildBarState(input: BuildBarStateInput): { state: DashboardBarState; marks: OutsideAccess } {
  const { saved, changes, access, known = {} } = input;
  const everything = access.everything;

  // A Scope value that no longer exists is named only for someone who holds Everything. Anyone else
  // gets it counted with the values outside their Access, so a Scoped person cannot learn whether it exists.
  const goneScope = (dim: BarListDimension, value: string) => dim === 'subscription' && !everything && isGone(dim, known, value);
  const heldBack = (dim: BarListDimension, value: string, marks: OutsideAccess) =>
    (dim === 'subscription' || dim === 'resourceGroup') && (isOutsideAccess(marks, dim, value) || goneScope(dim, value));

  const layered = applyChanges(saved, changes);
  const widgetValues = (key: 'subscriptions' | 'resourceGroups') => input.widgets.flatMap(w => {
    const value = w.config?.[key];
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  });
  const scopeValues = (dim: 'subscription' | 'resourceGroup', key: 'subscriptions' | 'resourceGroups') =>
    [...saved[dim], ...(changes[dim] ?? []), ...widgetValues(key)];
  const subscriptionValues = scopeValues('subscription', 'subscriptions');
  const marks = markOutsideAccess(access, { subscriptions: subscriptionValues, resourceGroups: scopeValues('resourceGroup', 'resourceGroups') });
  const withGone: OutsideAccess = {
    subscriptions: [...new Set([...marks.subscriptions, ...subscriptionValues.filter(v => goneScope('subscription', v))])],
    resourceGroups: marks.resourceGroups,
  };

  const dimensions = {} as Record<BarListDimension, BarDimensionState>;
  for (const dim of BAR_LIST_DIMENSIONS) {
    const inUrl = changes[dim] !== undefined;
    const effectiveAll = layered[dim];
    const savedAll = saved[dim];
    const visible = (values: string[]) => values.filter(v => !heldBack(dim, v, withGone));
    const effective = visible(effectiveAll);
    const vanishedIn = (values: string[]): VanishedValue[] => values.filter(v => isGone(dim, known, v)).map(value => dim === 'rule'
      ? { value, label: VANISHED_RULE_NOTE, note: VANISHED_RULE_NOTE }
      : { value, label: value, note: VANISHED_NOTE });
    dimensions[dim] = {
      effective,
      saved: visible(savedAll),
      changed: inUrl && !sameValues(changes[dim]!, savedAll),
      inUrl,
      outside: {
        saved: savedAll.length - visible(savedAll).length,
        url: inUrl ? changes[dim]!.length - visible(changes[dim]!).length : 0,
      },
      vanished: vanishedIn(effective),
      savedVanished: vanishedIn(visible(savedAll)),
    };
  }

  const effectiveWindow = changes.window ?? saved.window;
  const overridden = overriddenDimensions(input.widgets.map(w => w.config ?? {}));
  return {
    marks: withGone,
    state: {
      revision: input.revision,
      dimensions,
      window: { changed: !sameWindow(effectiveWindow, saved.window), saved: saved.window, effective: effectiveWindow },
      overriddenBy: overridden,
    },
  };
}

// ---- Picks ----

/** What a pick works on: the filters saved on the dashboard, the changes in the address as written, and the marks. */
export interface BarLayers {
  saved: DashboardFilters;
  changes: DashboardFilterChanges;
  marks: OutsideAccess;
}

export type PickResult = { changes: DashboardFilterChanges } | { refused: string };

const holds = (layers: BarLayers, dim: BarListDimension, value: string): boolean =>
  (dim === 'subscription' || dim === 'resourceGroup') && isOutsideAccess(layers.marks, dim, value);

/**
 * Ticks or unticks one value. An address that already sets the dimension keeps every other value as
 * written, held-back ones included. One that does not replaces the saved values with the person's own
 * choice, so what they cannot see is not carried into a link they send. A result that would leave no
 * value at all over held-back saved values would widen the dimension for others, so it is refused.
 */
export function toggleValue(layers: BarLayers, dim: BarListDimension, value: string): PickResult {
  const inUrl = layers.changes[dim] !== undefined;
  const current = layers.changes[dim] ?? layers.saved[dim];
  const has = current.includes(value);
  const next = has ? current.filter(v => v !== value) : [...current, value];
  const written = inUrl ? next : next.filter(v => !holds(layers, dim, v));
  if (written.length === 0 && layers.saved[dim].some(v => holds(layers, dim, v))) return { refused: UNTICK_LAST_REASON };
  return { changes: { ...layers.changes, [dim]: written } };
}

/** The explicit "any" pick. It is always allowed; the bar says why it widens a held-back dimension. */
export function pickAny(layers: BarLayers, dim: BarListDimension): PickResult {
  return { changes: { ...layers.changes, [dim]: [] } };
}

/** The changes with one dimension (or the window) back at what is saved. */
export function backToSaved(changes: DashboardFilterChanges, dim: BarDimension): DashboardFilterChanges {
  const { [dim]: _dropped, ...rest } = changes;
  return rest;
}
