/**
 * What the view routes (`/api/findings/{view,rows,group,column-values,export}`) read from their query
 * string, in one place: the View itself (`viewFromSearchParams`, which ignores what it does not
 * know), the tab, whether suppressed findings are shown, and the one or two params each route adds.
 * A bad value is an error message the route returns as a 400; nothing here throws.
 */
import { EXPORT_FORMATS, type ExportFormat } from './findings-export';
import { isRowField, viewFromSearchParams, type RowField, type View } from './finding-view';
import { parseViewTab, type ViewTab } from './view-response';
import { effectiveView } from './effective-filters';
import { OPEN_VIEW_PARAM, SAVED_VIEW_UNAVAILABLE } from './saved-view-query';

export interface ViewRequest {
  view: View; tab: ViewTab; showSuppressed: boolean;
  /** The revision of the saved view the read used, when one is open. */
  savedRevision?: number;
}
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** `tab=results|advisories|activity` (the Results tab when absent), `suppressed=1`, and the view's own params. */
export function parseViewRequest(params: URLSearchParams): Parsed<ViewRequest> {
  const rawTab = params.get('tab');
  const tab = rawTab === null ? 'results' : parseViewTab(rawTab);
  if (!tab) return fail('The tab must be results or advisories.');
  return { ok: true, value: { view: viewFromSearchParams(params), tab, showSuppressed: params.get('suppressed') === '1' } };
}

export type ReadViewRequest =
  | { ok: true; value: ViewRequest }
  | { ok: false; error: string; status: 400 | 404 };

/**
 * `parseViewRequest` for a route that may be asked for a saved view (`view=<id>&rev=<n>`). With a view
 * open, the View is the saved view with the query's changes on top (`effectiveView`), assembled here
 * and never from a copy the browser built; an unknown, deleted or unopenable view is a 404 with one
 * message. The read always uses the view as it is now; `rev` is ignored, and the revision it used is
 * `savedRevision`, so a page holding an older one can pick the change up.
 */
export async function readViewRequest(params: URLSearchParams): Promise<ReadViewRequest> {
  const parsed = parseViewRequest(params);
  if (!parsed.ok) return { ok: false, error: parsed.error, status: 400 };
  const viewId = params.get(OPEN_VIEW_PARAM);
  if (!viewId) return parsed;
  const effective = await effectiveView({ viewId, changes: params });
  if (!effective.ok) return { ok: false, error: SAVED_VIEW_UNAVAILABLE, status: 404 };
  return { ok: true, value: { ...parsed.value, view: effective.view, savedRevision: effective.saved.revision } };
}

/** `format=csv|json`: which file the export route writes. There is no default, so a link that forgot
 *  it is told so rather than handed the wrong kind of file. */
export function parseExportFormat(value: string | null): Parsed<ExportFormat> {
  const format = EXPORT_FORMATS.find(f => f === value);
  return format ? { ok: true, value: format } : fail('The format must be csv or json.');
}

/** A 1-based page param: a positive whole number, or 1 when absent or anything else. */
export function parsePageParam(value: string | null): number {
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 ? page : 1;
}


/** `groupPath` as a JSON array of group values, one per level, `null` for the empty-value group. */
export function parseGroupPath(value: string | null): Parsed<(string | null)[]> {
  if (value === null) return fail('groupPath is required.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return fail('groupPath must be a JSON array.');
  }
  if (!Array.isArray(parsed) || !parsed.every(v => v === null || typeof v === 'string')) {
    return fail('groupPath must be a JSON array of strings and nulls.');
  }
  return { ok: true, value: parsed as (string | null)[] };
}

/** `column=row.<path>`: the returned column whose values are wanted. */
export function parseColumnParam(value: string | null): Parsed<RowField> {
  if (value === null || !isRowField(value)) return fail('column must be row.<path>.');
  return { ok: true, value };
}
