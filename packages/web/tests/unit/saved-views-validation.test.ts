import { describe, expect, it } from 'vitest';
import { MAX_SAVED_VIEW_NAME_LENGTH, MAX_SAVED_VIEW_QUERY_LENGTH } from '@/lib/saved-view-query';
import { parseSavedViewFields, savedViewNameTakenMessage } from '@/lib/saved-views';

describe('parseSavedViewFields', () => {
  it('needs all three fields to create', () => {
    expect(parseSavedViewFields({ name: 'A', tab: 'results', query: '' }, 'create')).toEqual({
      ok: true, value: { name: 'A', tab: 'results', query: '' },
    });
    for (const missing of ['name', 'tab', 'query']) {
      const body: Record<string, unknown> = { name: 'A', tab: 'results', query: '' };
      delete body[missing];
      expect(parseSavedViewFields(body, 'create').ok).toBe(false);
    }
  });

  it('needs at least one field to update, and returns only those sent', () => {
    expect(parseSavedViewFields({}, 'update').ok).toBe(false);
    expect(parseSavedViewFields({ name: ' New ' }, 'update')).toEqual({ ok: true, value: { name: 'New' } });
  });

  it('measures the name after trimming and the query as sent', () => {
    expect(parseSavedViewFields({ name: ` ${'n'.repeat(MAX_SAVED_VIEW_NAME_LENGTH)} ` }, 'update').ok).toBe(true);
    expect(parseSavedViewFields({ name: 'n'.repeat(MAX_SAVED_VIEW_NAME_LENGTH + 1) }, 'update').ok).toBe(false);
    expect(parseSavedViewFields({ query: `q=${'a'.repeat(MAX_SAVED_VIEW_QUERY_LENGTH)}` }, 'update').ok).toBe(false);
  });

  it('refuses a body that is not an object', () => {
    expect(parseSavedViewFields('x', 'create').ok).toBe(false);
    expect(parseSavedViewFields(null, 'update').ok).toBe(false);
  });
});

describe('savedViewNameTakenMessage', () => {
  it('names the clashing name', () => {
    expect(savedViewNameTakenMessage('Prod')).toBe('A saved view named "Prod" already exists.');
  });
});
