/**
 * "Save as this dashboard's filters" (ADR 0013): the one explicit way a dashboard's saved filters change.
 * The saved filters are combined with the changes the person's address holds, what the saver cannot see
 * is merged back, and the result is written under a revision check. Widget overrides, layout and the
 * auto-refresh interval are not part of it.
 *
 * Two things are refused. A value outside the saver's Access in the address would be stored by someone
 * who cannot see it. "Any" over saved values the saver does not hold would widen the dashboard for people
 * who can. Neither is dropped quietly: the refusal says what to do.
 *
 * Whether the person may save at all is the caller's question (`dashboardEditControlFor`); this module
 * answers for the values.
 */
import { getDashboard, updateDashboardFilters } from '@/lib/db/dashboards';
import { buildBarState, type BarListDimension, type DashboardBarState } from '@/lib/dashboard-bar';
import { savedFiltersOf, sameValues } from '@/lib/dashboard-filters';
import { loadKnownValues } from '@/lib/dashboard-known-values';
import { sameWindow, type DashboardFilterChanges, type DashboardFilters } from '@/lib/finding-view';
import { isOutsideAccess, type OutsideAccess } from '@/lib/outside-access';
import { EXPLORER_SEVERITIES } from '@/lib/explorer-filters';
import type { Access } from '@/lib/access-model';
import type { Dashboard, DashboardConfig } from '@/lib/types';

/** The dimensions a save names in the audit log: names, never values. */
export type SavedDimension = keyof DashboardFilters;

const SCOPE_DIMENSIONS = ['subscription', 'resourceGroup'] as const;
type ScopeDimension = (typeof SCOPE_DIMENSIONS)[number];

const FILTER_KEY: Record<BarListDimension, keyof NonNullable<DashboardConfig['filters']>> = {
  category: 'categories', subscription: 'subscriptions', resourceGroup: 'resourceGroups', tags: 'tags', rule: 'ruleIds', severity: 'severities',
};
const LIST_DIMENSIONS = Object.keys(FILTER_KEY) as BarListDimension[];

export type FiltersPlan =
  | { ok: true; next: DashboardFilters; changed: SavedDimension[] }
  | { ok: false; reason: 'outside-access'; count: number }
  | { ok: false; reason: 'any-over-held-back'; dimensions: ScopeDimension[] };

const held = (marks: OutsideAccess, dim: ScopeDimension, value: string) => isOutsideAccess(marks, dim, value);

/** The filters to store for `changes` over `saved`, or why not. `marks` is what the saver's Access does not reach. */
export function planFiltersSave(saved: DashboardFilters, changes: DashboardFilterChanges, marks: OutsideAccess): FiltersPlan {
  const outside = new Set<string>();
  for (const dim of SCOPE_DIMENSIONS) {
    for (const value of changes[dim] ?? []) if (held(marks, dim, value)) outside.add(`${dim}:${value.toLowerCase()}`);
  }
  if (outside.size > 0) return { ok: false, reason: 'outside-access', count: outside.size };

  const widening = SCOPE_DIMENSIONS.filter(dim => changes[dim]?.length === 0 && saved[dim].some(v => held(marks, dim, v)));
  if (widening.length > 0) return { ok: false, reason: 'any-over-held-back', dimensions: widening };

  const next: DashboardFilters = { ...saved };
  for (const dim of LIST_DIMENSIONS) {
    const incoming = changes[dim];
    if (!incoming) continue;
    const isScope = (SCOPE_DIMENSIONS as readonly string[]).includes(dim);
    // The values the saver cannot see stay: they are not theirs to remove.
    const kept = isScope ? saved[dim].filter(v => held(marks, dim as ScopeDimension, v)) : [];
    next[dim] = [...new Set([...incoming, ...kept])];
  }
  if (changes.window) next.window = changes.window;

  const changed: SavedDimension[] = LIST_DIMENSIONS.filter(dim => !sameValues(next[dim], saved[dim]));
  if (!sameWindow(next.window, saved.window)) changed.push('window');
  return { ok: true, next, changed };
}

export type SaveFiltersResult =
  | { ok: true; dashboard: Dashboard; revision: number; bar: DashboardBarState; changed: SavedDimension[] }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'stale'; revision: number; bar: DashboardBarState }
  | Exclude<FiltersPlan, { ok: true }>;

export async function saveDashboardFilters(input: {
  dashboardId: string;
  /** The revision the person's page holds. */
  revision: number;
  changes: DashboardFilterChanges;
  access: Access;
}): Promise<SaveFiltersResult> {
  const dashboard = await getDashboard(input.dashboardId);
  if (!dashboard) return { ok: false, reason: 'not-found' };
  const known = await loadKnownValues();
  const saved = savedFiltersOf(dashboard.config);
  const widgets = dashboard.config.widgets;
  if (dashboard.revision !== input.revision) {
    // The bar of the newer revision, with the person's changes still on it, so the page can reload it.
    const { state } = buildBarState({ revision: dashboard.revision, saved, changes: input.changes, access: input.access, widgets, known });
    return { ok: false, reason: 'stale', revision: dashboard.revision, bar: state };
  }
  const { marks } = buildBarState({ revision: dashboard.revision, saved, changes: input.changes, access: input.access, widgets, known });

  const plan = planFiltersSave(saved, input.changes, marks);
  if (!plan.ok) return plan;
  if (plan.changed.length === 0) {
    const { state } = buildBarState({ revision: dashboard.revision, saved, changes: {}, access: input.access, widgets, known });
    return { ok: true, dashboard, revision: dashboard.revision, bar: state, changed: [] };
  }

  const lists: Partial<Record<NonNullable<keyof NonNullable<DashboardConfig['filters']>>, string[]>> = {};
  for (const dim of plan.changed) if (dim !== 'window') lists[FILTER_KEY[dim]] = plan.next[dim];
  const written = await updateDashboardFilters(input.dashboardId, input.revision, {
    lists,
    ...(plan.changed.includes('window') && { window: plan.next.window }),
  });
  if (!written.ok) {
    if (written.reason === 'not-found') return written;
    // Another save landed between the check and the write: the same conflict, against the newer revision.
    const newer = await getDashboard(input.dashboardId);
    if (!newer) return { ok: false, reason: 'not-found' };
    const { state } = buildBarState({
      revision: newer.revision, saved: savedFiltersOf(newer.config), changes: input.changes, access: input.access, widgets: newer.config.widgets, known,
    });
    return { ok: false, reason: 'stale', revision: newer.revision, bar: state };
  }

  const { state } = buildBarState({
    revision: written.dashboard.revision, saved: savedFiltersOf(written.dashboard.config), changes: {},
    access: input.access, widgets: written.dashboard.config.widgets, known,
  });
  return { ok: true, dashboard: written.dashboard, revision: written.dashboard.revision, bar: state, changed: plan.changed };
}

// ---- The request body ----

const MAX_VALUES = 500;
const MAX_VALUE_LENGTH = 300;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_WINDOW_DAYS = 3650;

function readList(dim: BarListDimension, raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_VALUES) return null;
  if (!raw.every(v => typeof v === 'string' && v !== '' && v.length <= MAX_VALUE_LENGTH)) return null;
  const values = [...new Set(raw as string[])];
  if (dim === 'severity' && !values.every(v => (EXPLORER_SEVERITIES as string[]).includes(v))) return null;
  if (dim === 'category' && values.includes('all')) return null;
  return values;
}

function readWindow(raw: unknown): DashboardFilters['window'] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const w = raw as Record<string, unknown>;
  if (w['mode'] === 'relative') {
    return typeof w['days'] === 'number' && Number.isInteger(w['days']) && w['days'] > 0 && w['days'] <= MAX_WINDOW_DAYS
      ? { mode: 'relative', days: w['days'] } : null;
  }
  if (w['mode'] === 'custom') {
    return typeof w['from'] === 'string' && typeof w['to'] === 'string' && DAY_KEY.test(w['from']) && DAY_KEY.test(w['to'])
      ? { mode: 'custom', from: w['from'], to: w['to'] } : null;
  }
  return null;
}

/** The changes a request body names, or `null` when any part of it is not a dimension's value. Nothing is skipped. */
export function parseFilterChanges(raw: unknown): DashboardFilterChanges | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const changes: DashboardFilterChanges = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'window') {
      const window = readWindow(value);
      if (!window) return null;
      changes.window = window;
    } else if ((LIST_DIMENSIONS as string[]).includes(key)) {
      const list = readList(key as BarListDimension, value);
      if (!list) return null;
      changes[key as BarListDimension] = list;
    } else {
      return null;
    }
  }
  return changes;
}

/** What the bar says when a save is refused. */
export function refusalMessage(refusal: Exclude<FiltersPlan, { ok: true }>): string {
  return refusal.reason === 'outside-access'
    ? `Your changes include ${refusal.count} ${refusal.count === 1 ? 'value' : 'values'} outside your access. Remove ${refusal.count === 1 ? 'it' : 'them'}, then save again.`
    : 'Any would widen this filter for people who can see values you cannot. Pick the values you want instead.';
}
