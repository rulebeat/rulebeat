/**
 * Updating a saved view with the current view, and saving a new view while one is open (ADR 0013). The
 * client sends the open view's id, the revision it holds and the address's changes, never a copy of the
 * query: the server puts the saved query and the changes together, so a value the person cannot see is
 * neither lost nor widened by a copy built in the browser.
 *
 * An update has the dashboard save's refusals. A value outside the saver's Access in a dimension the
 * address changed would be stored by someone who cannot see it, and Any over saved values they do not hold
 * would widen the view for people who can. What the saver cannot see is merged back when they change that
 * dimension. A new view is the saver's own, so what is outside their Access is dropped and counted.
 *
 * Whether the person may write at all is the route's question (`views:write`); this module answers for the
 * values and the revision.
 */
import { getSavedView, updateSavedView } from '@/lib/db/saved-views';
import { getUser } from '@/lib/db/users';
import { filterValues, savedViewAddress, viewFromSearchParams, viewToSearchParams, type View, type ViewFilter } from '@/lib/finding-view';
import { sameValues } from '@/lib/dashboard-filters';
import { isOutsideAccess, markedSavedView, markOutsideAccess } from '@/lib/outside-access';
import { SAVED_VIEW_CHANGED_MESSAGE } from '@/lib/saved-views';
import { MAX_SAVED_VIEW_QUERY_LENGTH, normalizeViewQuery, type SavedView, type SavedViewFields } from '@/lib/saved-view-query';
import type { Access } from '@/lib/access-model';

const SCOPE_DIMENSIONS = ['subscription', 'resourceGroup'] as const;
type ScopeDimension = (typeof SCOPE_DIMENSIONS)[number];

/** The fields a write can change, as the audit log names them. */
const SAVED_VIEW_CHANGE_FIELDS: (keyof SavedViewFields)[] = ['name', 'query'];

const withValues = (filters: ViewFilter[], field: ScopeDimension, values: string[]): ViewFilter[] => [
  ...filters.filter(f => f.field !== field),
  ...(values.length > 0 ? [{ field, values } as ViewFilter] : []),
];

/** What the access does not reach among `views`' subscription and resource group values. */
function marksOver(access: Access, ...views: View[]) {
  const all = (field: ScopeDimension) => views.flatMap(v => filterValues(v.filters, field));
  return markOutsideAccess(access, { subscriptions: all('subscription'), resourceGroups: all('resourceGroup') });
}

const queryOf = (view: View): string => normalizeViewQuery(viewToSearchParams(view).toString());
const openedView = (stored: SavedView): View => ({ ...viewFromSearchParams(new URLSearchParams(stored.query)), page: 1 });

export type ViewRefusal =
  | { ok: false; reason: 'outside-access'; count: number }
  | { ok: false; reason: 'any-over-held-back'; dimensions: ScopeDimension[] };

/** The query to store for `effective` (the saved view with the address's changes on top), or why not. */
export function planViewUpdate(saved: View, effective: View, access: Access): { ok: true; query: string } | ViewRefusal {
  const marks = marksOver(access, saved, effective);
  const isOutside = (dim: ScopeDimension, value: string) => isOutsideAccess(marks, dim, value);
  const changed = SCOPE_DIMENSIONS.filter(dim => !sameValues(filterValues(effective.filters, dim), filterValues(saved.filters, dim)));

  const outside = new Set<string>();
  for (const dim of changed) {
    // A held-back value the view already saved is not one the saver adds: it stays, and is merged back below.
    const savedBefore = new Set(filterValues(saved.filters, dim).map(v => v.toLowerCase()));
    for (const value of filterValues(effective.filters, dim)) {
      if (isOutside(dim, value) && !savedBefore.has(value.toLowerCase())) outside.add(`${dim}:${value.toLowerCase()}`);
    }
  }
  if (outside.size > 0) return { ok: false, reason: 'outside-access', count: outside.size };

  const widening = changed.filter(dim => filterValues(effective.filters, dim).length === 0 && filterValues(saved.filters, dim).some(v => isOutside(dim, v)));
  if (widening.length > 0) return { ok: false, reason: 'any-over-held-back', dimensions: widening };

  let filters = effective.filters;
  for (const dim of changed) {
    // The values the saver cannot see stay: they are not theirs to remove.
    const kept = filterValues(saved.filters, dim).filter(v => isOutside(dim, v));
    filters = withValues(filters, dim, [...new Set([...filterValues(effective.filters, dim), ...kept])]);
  }
  return { ok: true, query: queryOf({ ...effective, filters }) };
}

export type SaveViewResult =
  | { ok: true; view: SavedView; before: SavedView; changed: (keyof SavedViewFields)[] }
  | { ok: false; reason: 'not-found' | 'name-taken' | 'too-long' }
  | { ok: false; reason: 'stale'; view: SavedView }
  | ViewRefusal;

/** "Update with current view" and a rename: `changes` over the saved query, `name`, or both, in one write. */
export async function saveViewChanges(input: {
  viewId: string;
  /** The revision the person's page holds. */
  revision: number;
  changes?: URLSearchParams;
  name?: string;
  access: Access;
  actorId?: string | null;
}): Promise<SaveViewResult> {
  const stored = await getSavedView(input.viewId);
  if (!stored) return { ok: false, reason: 'not-found' };
  if (stored.revision !== input.revision) return { ok: false, reason: 'stale', view: stored };

  const fields: Partial<SavedViewFields> = {};
  if (input.name !== undefined && input.name !== stored.name) fields.name = input.name;
  if (input.changes) {
    const saved = openedView(stored);
    const plan = planViewUpdate(saved, savedViewAddress(saved).read(input.changes), input.access);
    if (!plan.ok) return plan;
    // The limit holds for what is stored, not only for what the client sent.
    if (plan.query.length > MAX_SAVED_VIEW_QUERY_LENGTH) return { ok: false, reason: 'too-long' };
    if (plan.query !== normalizeViewQuery(stored.query)) fields.query = plan.query;
  }
  if (Object.keys(fields).length === 0) return { ok: true, view: stored, before: stored, changed: [] };

  const written = await updateSavedView(input.viewId, fields, input.actorId ?? null, input.revision);
  if (!written.ok) {
    if (written.reason !== 'stale') return written;
    // Another save landed between the check and the write: the same conflict, against the newer view.
    const newer = await getSavedView(input.viewId);
    return newer ? { ok: false, reason: 'stale', view: newer } : { ok: false, reason: 'not-found' };
  }
  const changed = SAVED_VIEW_CHANGE_FIELDS.filter(f => f in fields);
  return { ok: true, view: written.view, before: written.before, changed };
}


export type BuiltViewResult =
  | { ok: true; query: string; dropped: number }
  | { ok: false; reason: 'not-found' | 'too-long' }
  | { ok: false; reason: 'stale'; view: SavedView };

/** The query of a new view made from the open one: the effective View with what the saver cannot see dropped and counted. */
export async function buildViewFromOpen(input: { viewId: string; revision: number; changes: URLSearchParams; access: Access }): Promise<BuiltViewResult> {
  const stored = await getSavedView(input.viewId);
  if (!stored) return { ok: false, reason: 'not-found' };
  if (stored.revision !== input.revision) return { ok: false, reason: 'stale', view: stored };

  const saved = openedView(stored);
  const effective = savedViewAddress(saved).read(input.changes);
  const marks = marksOver(input.access, effective);
  const dropped = new Set<string>();
  let filters = effective.filters;
  for (const dim of SCOPE_DIMENSIONS) {
    const values = filterValues(effective.filters, dim);
    const kept = values.filter(v => !isOutsideAccess(marks, dim, v));
    for (const v of values) if (!kept.includes(v)) dropped.add(`${dim}:${v.toLowerCase()}`);
    if (kept.length !== values.length) filters = withValues(filters, dim, kept);
  }
  const query = queryOf({ ...effective, filters });
  if (query.length > MAX_SAVED_VIEW_QUERY_LENGTH) return { ok: false, reason: 'too-long' };
  return { ok: true, query, dropped: dropped.size };
}

/** What the bar says when an update is refused. */
export function viewRefusalMessage(refusal: ViewRefusal): string {
  return refusal.reason === 'outside-access'
    ? `Your changes include ${refusal.count} ${refusal.count === 1 ? 'value' : 'values'} outside your access. Remove ${refusal.count === 1 ? 'it' : 'them'}, then update again.`
    : 'Any would widen this view for people who can see values you cannot. Pick the values you want instead.';
}

/**
 * The answer to a save over a revision the view no longer has: the view as it is now, and who changed it
 * and when. Nothing was written, and the person's changes are still in their address.
 */
export async function staleAnswer(view: SavedView, access: Access): Promise<Response> {
  const person = view.updatedBy ? await getUser(view.updatedBy) : null;
  return Response.json({
    error: SAVED_VIEW_CHANGED_MESSAGE,
    revision: view.revision,
    view: markedSavedView(access, view),
    ...(person && { changedBy: person.name || person.email, changedAt: view.updatedAt }),
  }, { status: 409 });
}
