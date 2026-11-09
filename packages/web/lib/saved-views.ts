/**
 * The server side of Saved views' requests: what a create or update body may say, and the messages
 * for a name already in use and for a revision the page no longer holds. The client-safe shape and
 * limits are in lib/saved-view-query.ts, and the repository is lib/db/saved-views.ts.
 */
import {
  MAX_SAVED_VIEW_NAME_LENGTH, MAX_SAVED_VIEW_QUERY_LENGTH, isSavedViewTab, normalizeViewQuery,
  type SavedViewFields, type SavedViewTab,
} from './saved-view-query';

/** Every field a saved view carries, as the audit log names them. */
export const SAVED_VIEW_FIELDS: readonly (keyof SavedViewFields)[] = ['name', 'tab', 'query'];

/** The 409 message the create and rename routes answer with when a name is already in use. */
export function savedViewNameTakenMessage(name: string): string {
  return `A saved view named "${name}" already exists.`;
}

type FieldsResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** What the update and save-from-open routes answer 409 with when the page holds no revision, or an older one. */
export const SAVED_VIEW_CHANGED_MESSAGE = 'This saved view changed since you opened it. Reload to continue.';

/** The most a request's `changes` may be: the address's differences, which are at most a View's query. */
const MAX_CHANGES_LENGTH = 2 * MAX_SAVED_VIEW_QUERY_LENGTH;

function bodyObject(body: unknown): Record<string, unknown> {
  return (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
}

/** The revision a request holds, or null when it holds none (absent, or not a whole number). */
export function readRevision(body: unknown): number | null {
  const revision = bodyObject(body).revision;
  return typeof revision === 'number' && Number.isInteger(revision) && revision >= 1 ? revision : null;
}

function readName(input: Record<string, unknown>): FieldsResult<string | undefined> {
  if (input.name === undefined) return { ok: true, value: undefined };
  if (typeof input.name !== 'string' || !input.name.trim()) return { ok: false, error: 'Name is required.' };
  if (input.name.trim().length > MAX_SAVED_VIEW_NAME_LENGTH) {
    return { ok: false, error: `Name must be ${MAX_SAVED_VIEW_NAME_LENGTH} characters or fewer.` };
  }
  return { ok: true, value: input.name.trim() };
}

function readChanges(input: Record<string, unknown>): FieldsResult<URLSearchParams | undefined> {
  if (input.changes === undefined) return { ok: true, value: undefined };
  if (typeof input.changes !== 'string') return { ok: false, error: 'Changes must be a query string.' };
  if (input.changes.length > MAX_CHANGES_LENGTH) return { ok: false, error: `Changes must be ${MAX_CHANGES_LENGTH} characters or fewer.` };
  return { ok: true, value: new URLSearchParams(input.changes) };
}

/**
 * Reads and cleans a create body for a view saved with none open. All three fields are needed. The name
 * is trimmed, and the query is normalised, so what is stored is the View's canonical query. The length
 * limit applies to what the client sent and to what is stored.
 */
export function parseSavedViewFields(body: unknown): FieldsResult<SavedViewFields> {
  const input = bodyObject(body);
  const name = readName(input);
  if (!name.ok) return name;
  if (name.value === undefined) return { ok: false, error: 'Name is required.' };
  if (input.tab === undefined) return { ok: false, error: 'Tab is required.' };
  if (!isSavedViewTab(input.tab)) return { ok: false, error: 'Tab must be "results", "advisories" or "activity".' };
  if (input.query === undefined) return { ok: false, error: 'Query is required.' };
  if (typeof input.query !== 'string') return { ok: false, error: 'Query must be a string.' };
  const tooLong = { ok: false, error: `Query must be ${MAX_SAVED_VIEW_QUERY_LENGTH} characters or fewer.` } as const;
  if (input.query.length > MAX_SAVED_VIEW_QUERY_LENGTH) return tooLong;
  const query = normalizeViewQuery(input.query);
  if (query.length > MAX_SAVED_VIEW_QUERY_LENGTH) return tooLong;
  return { ok: true, value: { name: name.value, tab: input.tab, query } };
}

/**
 * Reads an update body: a new `name`, the address's `changes` over the saved query, or both. A query or a
 * tab is refused: the browser does not send a copy of the view, the server builds it from the changes.
 */
export function parseSavedViewUpdate(body: unknown): FieldsResult<{ name?: string; changes?: URLSearchParams }> {
  const input = bodyObject(body);
  if (input.query !== undefined || input.tab !== undefined) {
    return { ok: false, error: 'Send the changes to the view, not a query or a tab.' };
  }
  const name = readName(input);
  if (!name.ok) return name;
  const changes = readChanges(input);
  if (!changes.ok) return changes;
  if (name.value === undefined && changes.value === undefined) return { ok: false, error: 'Send at least one of name or changes.' };
  return { ok: true, value: { ...(name.value !== undefined && { name: name.value }), ...(changes.value && { changes: changes.value }) } };
}

/** Reads a create body that names the open view it is saved from: `{ name, tab, fromView, changes }`. */
export function parseSavedViewFromOpen(body: unknown): FieldsResult<{ name: string; tab: SavedViewTab; fromView: string; changes: URLSearchParams }> {
  const input = bodyObject(body);
  if (input.query !== undefined) return { ok: false, error: 'Send the changes to the open view, not a query.' };
  if (typeof input.fromView !== 'string' || input.fromView === '') return { ok: false, error: 'The open view must be an id.' };
  const name = readName(input);
  if (!name.ok) return name;
  if (name.value === undefined) return { ok: false, error: 'Name is required.' };
  if (input.tab === undefined) return { ok: false, error: 'Tab is required.' };
  if (!isSavedViewTab(input.tab)) return { ok: false, error: 'Tab must be "results", "advisories" or "activity".' };
  const changes = readChanges(input);
  if (!changes.ok) return changes;
  return { ok: true, value: { name: name.value, tab: input.tab, fromView: input.fromView, changes: changes.value ?? new URLSearchParams() } };
}
