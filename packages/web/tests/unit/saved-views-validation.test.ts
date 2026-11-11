import { describe, expect, it } from 'vitest';
import { MAX_SAVED_VIEW_NAME_LENGTH, MAX_SAVED_VIEW_QUERY_LENGTH } from '@/lib/saved-view-query';
import {
  parseSavedViewFields, parseSavedViewFromOpen, parseSavedViewUpdate, readRevision, savedViewNameTakenMessage,
} from '@/lib/saved-views';

describe('parseSavedViewFields', () => {
  it('needs all three fields to create', () => {
    expect(parseSavedViewFields({ name: 'A', tab: 'results', query: '' })).toEqual({
      ok: true, value: { name: 'A', tab: 'results', query: '' },
    });
    for (const missing of ['name', 'tab', 'query']) {
      const body: Record<string, unknown> = { name: 'A', tab: 'results', query: '' };
      delete body[missing];
      expect(parseSavedViewFields(body).ok).toBe(false);
    }
  });

  it('measures the name after trimming and the query as sent', () => {
    expect(parseSavedViewFields({ name: ` ${'n'.repeat(MAX_SAVED_VIEW_NAME_LENGTH)} `, tab: 'results', query: '' }).ok).toBe(true);
    expect(parseSavedViewFields({ name: 'n'.repeat(MAX_SAVED_VIEW_NAME_LENGTH + 1), tab: 'results', query: '' }).ok).toBe(false);
    expect(parseSavedViewFields({ name: 'A', tab: 'results', query: `q=${'a'.repeat(MAX_SAVED_VIEW_QUERY_LENGTH)}` }).ok).toBe(false);
  });

  it('refuses a body that is not an object', () => {
    expect(parseSavedViewFields('x').ok).toBe(false);
    expect(parseSavedViewFields(null).ok).toBe(false);
  });
});

describe('parseSavedViewUpdate', () => {
  it('needs at least one of name or changes, and returns only those sent', () => {
    expect(parseSavedViewUpdate({}).ok).toBe(false);
    expect(parseSavedViewUpdate({ name: ' New ' })).toEqual({ ok: true, value: { name: 'New' } });
    const changes = parseSavedViewUpdate({ changes: 'severity=low' });
    expect(changes.ok && changes.value.changes?.get('severity')).toBe('low');
    expect(changes.ok && changes.value.name).toBeUndefined();
  });

  it('accepts empty changes as a change that names nothing', () => {
    const parsed = parseSavedViewUpdate({ changes: '' });
    expect(parsed.ok && [...parsed.value.changes!]).toEqual([]);
  });

  it('measures the name after trimming', () => {
    expect(parseSavedViewUpdate({ name: ` ${'n'.repeat(MAX_SAVED_VIEW_NAME_LENGTH)} ` }).ok).toBe(true);
    expect(parseSavedViewUpdate({ name: 'n'.repeat(MAX_SAVED_VIEW_NAME_LENGTH + 1) }).ok).toBe(false);
  });

  it('refuses a query or a tab, which only the server builds', () => {
    expect(parseSavedViewUpdate({ query: 'severity=low' }).ok).toBe(false);
    expect(parseSavedViewUpdate({ name: 'A', tab: 'advisories' }).ok).toBe(false);
  });

  it('refuses changes that are not a string or are too long', () => {
    expect(parseSavedViewUpdate({ changes: { severity: 'low' } }).ok).toBe(false);
    expect(parseSavedViewUpdate({ changes: `q=${'a'.repeat(2 * MAX_SAVED_VIEW_QUERY_LENGTH)}` }).ok).toBe(false);
  });
});

describe('parseSavedViewFromOpen', () => {
  it('reads the open view, the name, the tab and the changes', () => {
    const parsed = parseSavedViewFromOpen({ name: ' Copy ', tab: 'advisories', fromView: 'v1', changes: 'severity=low' });
    expect(parsed.ok && parsed.value).toMatchObject({ name: 'Copy', tab: 'advisories', fromView: 'v1' });
  });

  it('takes no changes as none', () => {
    const parsed = parseSavedViewFromOpen({ name: 'Copy', tab: 'results', fromView: 'v1' });
    expect(parsed.ok && [...parsed.value.changes]).toEqual([]);
  });

  it('refuses a query beside the open view, a missing name or tab, and a blank view id', () => {
    expect(parseSavedViewFromOpen({ name: 'A', tab: 'results', fromView: 'v1', query: '' }).ok).toBe(false);
    expect(parseSavedViewFromOpen({ tab: 'results', fromView: 'v1' }).ok).toBe(false);
    expect(parseSavedViewFromOpen({ name: 'A', fromView: 'v1' }).ok).toBe(false);
    expect(parseSavedViewFromOpen({ name: 'A', tab: 'runs', fromView: 'v1' }).ok).toBe(false);
    expect(parseSavedViewFromOpen({ name: 'A', tab: 'results', fromView: '' }).ok).toBe(false);
  });
});

describe('readRevision', () => {
  it('reads a whole number of 1 or more', () => {
    expect(readRevision({ revision: 3 })).toBe(3);
  });

  it('reads nothing from a missing, fractional, zero, negative or non-numeric revision', () => {
    for (const revision of [undefined, 1.5, 0, -1, '2', null]) expect(readRevision({ revision })).toBeNull();
    expect(readRevision(null)).toBeNull();
  });
});

describe('savedViewNameTakenMessage', () => {
  it('names the clashing name', () => {
    expect(savedViewNameTakenMessage('Prod')).toBe('A saved view named "Prod" already exists.');
  });
});
