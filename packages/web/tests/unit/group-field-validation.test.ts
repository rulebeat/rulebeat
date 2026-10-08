/**
 * Issue #178: the Group column is validated by the same projected-column check as the Deadline
 * column, with its own label in every message. A column the query does not return would put every
 * Advisory in the one ungrouped bucket and say nothing, so the save is refused with a message that
 * names the column.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  checkGroupFieldRequest, validateGroupField, normalizeGroupField,
  GROUP_BACKEND_ERROR, GROUP_TYPE_ERROR,
} from '@/lib/group-field-validation';
import { DEADLINE_BACKEND_ERROR, DEADLINE_TYPE_ERROR } from '@/lib/deadline-field-validation';

vi.mock('@/lib/azure-credential', () => ({
  createTenantContext: () => Promise.reject(new Error('no credential configured')),
}));

const never = () => Promise.reject(new Error('probe must not run'));
const PROJECTED = { rawKql: 'resources | project id, name, owner = tostring(tags.owner)' };

describe('normalizeGroupField()', () => {
  it('reads null, undefined and blank as none, and trims a name', () => {
    expect(normalizeGroupField(undefined)).toEqual({ ok: true, field: undefined });
    expect(normalizeGroupField(null)).toEqual({ ok: true, field: undefined });
    expect(normalizeGroupField('   ')).toEqual({ ok: true, field: undefined });
    expect(normalizeGroupField(' owner ')).toEqual({ ok: true, field: 'owner' });
  });

  it.each([7, true, {}, ['a']])('refuses %j', value => {
    expect(normalizeGroupField(value)).toEqual({ ok: false, error: GROUP_TYPE_ERROR });
  });
});

describe('the Group messages', () => {
  it('name the Group column, not the Deadline column, and carry no em dash', () => {
    for (const message of [GROUP_BACKEND_ERROR, GROUP_TYPE_ERROR]) {
      expect(message).toContain('Group');
      expect(message).not.toContain('Deadline');
      expect(message).not.toContain('\u2014');
    }
    expect(GROUP_BACKEND_ERROR).not.toBe(DEADLINE_BACKEND_ERROR);
    expect(GROUP_TYPE_ERROR).not.toBe(DEADLINE_TYPE_ERROR);
  });
});

describe('validateGroupField()', () => {
  it('accepts a projected column and refuses one the query does not return, naming it', async () => {
    expect(await validateGroupField('owner', PROJECTED, never)).toBeNull();
    const message = await validateGroupField('team', PROJECTED, never);
    expect(message).toContain('"team"');
    expect(message).toContain('Group');
    expect(message).not.toContain('Deadline');
  });

  it.each(['microsoft-graph', 'log-analytics'] as const)('refuses a %s rule', async backend => {
    expect(await validateGroupField('x', { queryBackend: backend, ...PROJECTED }, never)).toBe(GROUP_BACKEND_ERROR);
  });

  it('samples a query whose projection cannot be read, and lets an empty sample through', async () => {
    const rule = { rawKql: 'resources | where type == "x"' };
    expect(await validateGroupField('team', rule, async () => [{ id: 'a' }])).toContain('"team"');
    expect(await validateGroupField('team', rule, async () => [{ team: 'platform' }])).toBeNull();
    expect(await validateGroupField('team', rule, async () => [])).toBeNull();
  });
});

describe('checkGroupFieldRequest()', () => {
  const base = { stored: undefined, kind: 'advisory' as const, rule: PROJECTED, probeRows: never };

  it('returns the field to store, and none for a blank or null request', async () => {
    expect(await checkGroupFieldRequest({ ...base, requested: 'owner' })).toEqual({ ok: true, field: 'owner' });
    expect(await checkGroupFieldRequest({ ...base, requested: null })).toEqual({ ok: true, field: undefined });
    expect(await checkGroupFieldRequest({ ...base, requested: '' })).toEqual({ ok: true, field: undefined });
  });

  it('leaves an unchanged stale column alone on a Problem rule, but not on an Advisory', async () => {
    const stale = { ...base, stored: 'gone', requested: 'gone' };
    expect(await checkGroupFieldRequest({ ...stale, kind: 'state' })).toEqual({ ok: true, field: 'gone' });
    expect((await checkGroupFieldRequest({ ...stale, kind: 'advisory' })).ok).toBe(false);
  });

  it('refuses a non-string request', async () => {
    expect(await checkGroupFieldRequest({ ...base, requested: 3 })).toEqual({ ok: false, error: GROUP_TYPE_ERROR });
  });
});
