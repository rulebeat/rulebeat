/**
 * The server side of Saved views' requests: what a create or update body may say, and the message
 * for a name already in use. The client-safe shape and limits are in lib/saved-view-query.ts, and
 * the repository is lib/db/saved-views.ts.
 */
import {
  MAX_SAVED_VIEW_NAME_LENGTH, MAX_SAVED_VIEW_QUERY_LENGTH, isSavedViewTab, normalizeViewQuery,
  type SavedViewFields,
} from './saved-view-query';

/** Every field a saved view carries, as the audit log names them. */
export const SAVED_VIEW_FIELDS: readonly (keyof SavedViewFields)[] = ['name', 'tab', 'query'];

/** The 409 message the create and rename routes answer with when a name is already in use. */
export function savedViewNameTakenMessage(name: string): string {
  return `A saved view named "${name}" already exists.`;
}

type FieldsResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Reads and cleans a create or update body. A create needs all three fields; an update needs at
 * least one. The name is trimmed, and the query is normalised, so what is stored is the View's
 * canonical query. The length limit applies to what the client sent and to what is stored.
 */
export function parseSavedViewFields(body: unknown, mode: 'create'): FieldsResult<SavedViewFields>;
export function parseSavedViewFields(body: unknown, mode: 'update'): FieldsResult<Partial<SavedViewFields>>;
export function parseSavedViewFields(body: unknown, mode: 'create' | 'update'): FieldsResult<Partial<SavedViewFields>> {
  const input = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const value: Partial<SavedViewFields> = {};

  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || !input.name.trim()) return { ok: false, error: 'Name is required.' };
    if (input.name.trim().length > MAX_SAVED_VIEW_NAME_LENGTH) {
      return { ok: false, error: `Name must be ${MAX_SAVED_VIEW_NAME_LENGTH} characters or fewer.` };
    }
    value.name = input.name.trim();
  }
  if (input.tab !== undefined) {
    if (!isSavedViewTab(input.tab)) return { ok: false, error: 'Tab must be "results", "advisories" or "activity".' };
    value.tab = input.tab;
  }
  if (input.query !== undefined) {
    if (typeof input.query !== 'string') return { ok: false, error: 'Query must be a string.' };
    const tooLong = { ok: false, error: `Query must be ${MAX_SAVED_VIEW_QUERY_LENGTH} characters or fewer.` } as const;
    if (input.query.length > MAX_SAVED_VIEW_QUERY_LENGTH) return tooLong;
    value.query = normalizeViewQuery(input.query);
    if (value.query.length > MAX_SAVED_VIEW_QUERY_LENGTH) return tooLong;
  }

  if (mode === 'create') {
    if (value.name === undefined) return { ok: false, error: 'Name is required.' };
    if (value.tab === undefined) return { ok: false, error: 'Tab is required.' };
    if (value.query === undefined) return { ok: false, error: 'Query is required.' };
  } else if (Object.keys(value).length === 0) {
    return { ok: false, error: 'Send at least one of name, tab or query.' };
  }
  return { ok: true, value };
}
