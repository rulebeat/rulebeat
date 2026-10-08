/**
 * Issue #177: a Deadline column the query does not return would leave every Advisory without a
 * Deadline and say nothing, so the save is refused with a message that names the column. The
 * projection is read from the KQL when it can be, and sampled otherwise; a sample that cannot
 * decide (no rows, no credential) lets the save through.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  checkDeadlineFieldRequest, validateDeadlineField, normalizeDeadlineField, knownProjectedColumns,
  DEADLINE_BACKEND_ERROR, DEADLINE_TYPE_ERROR,
} from '@/lib/deadline-field-validation';

vi.mock('@/lib/azure-credential', () => ({
  createTenantContext: () => Promise.reject(new Error('no credential configured')),
}));

const never = () => Promise.reject(new Error('probe must not run'));
const PROJECTED = { rawKql: 'resources | project id, name, retiresOn = tostring(properties.retireDate)' };

describe('normalizeDeadlineField()', () => {
  it('reads null, undefined and blank as none, and trims a name', () => {
    expect(normalizeDeadlineField(undefined)).toEqual({ ok: true, field: undefined });
    expect(normalizeDeadlineField(null)).toEqual({ ok: true, field: undefined });
    expect(normalizeDeadlineField('   ')).toEqual({ ok: true, field: undefined });
    expect(normalizeDeadlineField(' retiresOn ')).toEqual({ ok: true, field: 'retiresOn' });
  });

  it.each([7, true, {}, ['a']])('refuses %j', value => {
    expect(normalizeDeadlineField(value)).toEqual({ ok: false, error: DEADLINE_TYPE_ERROR });
  });
});

describe('knownProjectedColumns()', () => {
  it('reads the final project of a raw query', () => {
    expect(knownProjectedColumns(PROJECTED)).toEqual(['id', 'name', 'retiresOn']);
  });

  it('uses the output columns of a builder rule, or the default columns when it has none', () => {
    expect(knownProjectedColumns({ projectColumns: ['id', 'dueDate'] })).toEqual(['id', 'dueDate']);
    expect(knownProjectedColumns({})).toEqual(expect.arrayContaining(['id', 'name', 'type']));
  });

  it('is null for a raw query with no trailing project', () => {
    expect(knownProjectedColumns({ rawKql: 'resources | where type == "x"' })).toBeNull();
  });
});

describe('validateDeadlineField()', () => {
  it('accepts a projected column and refuses one the query does not return, naming it', async () => {
    expect(await validateDeadlineField('retiresOn', PROJECTED, never)).toBeNull();
    const message = await validateDeadlineField('dueDate', PROJECTED, never);
    expect(message).toContain('"dueDate"');
    expect(message).toMatch(/not a column this query returns/);
    expect(message).not.toContain('\u2014');
  });

  it('checks a builder rule against its output columns', async () => {
    expect(await validateDeadlineField('dueDate', { projectColumns: ['id', 'dueDate'] }, never)).toBeNull();
    expect(await validateDeadlineField('dueDate', {}, never)).toContain('"dueDate"');
  });

  it.each(['microsoft-graph', 'log-analytics'] as const)('refuses a %s rule', async backend => {
    expect(await validateDeadlineField('x', { queryBackend: backend, ...PROJECTED }, never)).toBe(DEADLINE_BACKEND_ERROR);
  });

  describe('a query whose projection cannot be read', () => {
    const rule = { rawKql: 'resources | where type == "x"' };

    it('samples the query and refuses when the rows lack the column', async () => {
      const probe = vi.fn(async (_kql: string) => [{ id: 'a', name: 'b' }]);
      expect(await validateDeadlineField('dueDate', rule, probe)).toContain('"dueDate"');
      expect(probe.mock.calls[0][0]).toMatch(/\| take 5$/);
    });

    it('accepts when a sampled row carries the column', async () => {
      expect(await validateDeadlineField('dueDate', rule, async () => [{ id: 'a', dueDate: '2030-01-01' }])).toBeNull();
    });

    it('does not add a take to a query that already has one', async () => {
      const probe = vi.fn(async (_kql: string) => [{ dueDate: 'x' }]);
      await validateDeadlineField('dueDate', { rawKql: 'resources | take 3' }, probe);
      expect(probe.mock.calls[0][0]).toBe('resources | take 3');
    });

    it('lets the save through when the sample has no rows or cannot run', async () => {
      expect(await validateDeadlineField('dueDate', rule, async () => [])).toBeNull();
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await validateDeadlineField('dueDate', rule, () => Promise.reject(new Error('429')))).toBeNull();
      spy.mockRestore();
    });
  });
});

describe('checkDeadlineFieldRequest()', () => {
  const base = { stored: undefined, kind: 'advisory' as const, rule: PROJECTED, probeRows: never };

  it('returns the field to store, and none for a blank or null request', async () => {
    expect(await checkDeadlineFieldRequest({ ...base, requested: 'retiresOn' })).toEqual({ ok: true, field: 'retiresOn' });
    expect(await checkDeadlineFieldRequest({ ...base, requested: null })).toEqual({ ok: true, field: undefined });
    expect(await checkDeadlineFieldRequest({ ...base, requested: '' })).toEqual({ ok: true, field: undefined });
  });

  it('refuses an unprojected column on an Advisory and on a Problem rule when it is new', async () => {
    expect((await checkDeadlineFieldRequest({ ...base, requested: 'nope' })).ok).toBe(false);
    expect((await checkDeadlineFieldRequest({ ...base, kind: 'state', requested: 'nope' })).ok).toBe(false);
  });

  it('leaves an unchanged stale column alone on a Problem rule, but not on an Advisory', async () => {
    const stale = { ...base, stored: 'gone', requested: 'gone' };
    expect(await checkDeadlineFieldRequest({ ...stale, kind: 'state' })).toEqual({ ok: true, field: 'gone' });
    expect((await checkDeadlineFieldRequest({ ...stale, kind: 'advisory' })).ok).toBe(false);
  });

  it('refuses a non-string request', async () => {
    expect(await checkDeadlineFieldRequest({ ...base, requested: 3 })).toEqual({ ok: false, error: DEADLINE_TYPE_ERROR });
  });
});
