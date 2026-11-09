/**
 * Updating a saved view with the current view, and saving a new view with one open (ADR 0013): the
 * server puts the saved query and the address's changes together, merges back what the saver cannot see,
 * refuses what would widen or store a value outside their Access, and writes under a revision check.
 * Fixture: the view saves Subscription {A, B} and Severity critical; L holds B only; LC holds B and C.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createSavedView, getSavedView, updateSavedView } from '@/lib/db/saved-views';
import { buildViewFromOpen, saveViewChanges } from '@/lib/saved-view-save';
import { buildAccess, type Access } from '@/lib/access-model';
import { resetDb } from '../helpers/db';
import { EVERYTHING_ACCESS } from '../helpers/access';

const SUB_A = '00000000-0000-0000-0000-00000000000a';
const SUB_B = '00000000-0000-0000-0000-00000000000b';
const holding = (...ids: string[]): Access => buildAccess(
  ids.map(id => ({ tenantId: 't', scope: { kind: 'subscription' as const, path: `/subscriptions/${id}` }, role: 'editor' as const })),
  'manual',
);
const SUB_C = '00000000-0000-0000-0000-00000000000c';
const SUB_D = '00000000-0000-0000-0000-00000000000d';
const L = holding(SUB_B);
const LC = holding(SUB_B, SUB_C);

let id: string;
beforeEach(async () => {
  await resetDb();
  const made = await createSavedView({ name: `view ${crypto.randomUUID()}`, tab: 'results', query: `severity=critical&subscription=${SUB_A}%2C${SUB_B}` }, null);
  if (!made.ok) throw new Error('create failed');
  id = made.view.id;
});

const stored = async () => (await getSavedView(id))!;
const params = (query: string) => new URLSearchParams(query);

describe('updating a saved view with the current view', () => {
  it('stores the saved query with the changes on top and bumps the revision', async () => {
    const before = await stored();
    const result = await saveViewChanges({ viewId: id, revision: before.revision, changes: params('severity=high&q=vm'), access: EVERYTHING_ACCESS });
    expect(result.ok).toBe(true);
    const after = await stored();
    expect(after.query).toBe(`severity=high&subscription=${SUB_A}%2C${SUB_B}&q=vm`);
    expect(after.revision).toBe(before.revision + 1);
  });

  it('names the fields that changed, never their values', async () => {
    const result = await saveViewChanges({ viewId: id, revision: (await stored()).revision, changes: params('severity=high&q=vm'), access: EVERYTHING_ACCESS });
    expect(result.ok && result.changed).toEqual(['query']);
  });

  it('renames in the same write as the changes, under the same revision check', async () => {
    const before = await stored();
    const result = await saveViewChanges({ viewId: id, revision: before.revision, name: 'Both at once', changes: params('severity=low'), access: EVERYTHING_ACCESS });
    expect(result.ok && result.changed).toEqual(['name', 'query']);
    expect((await stored()).revision).toBe(before.revision + 1);
  });

  it('refuses a rename over an older revision', async () => {
    const before = await stored();
    await updateSavedView(id, { query: 'severity=low' }, null);
    const result = await saveViewChanges({ viewId: id, revision: before.revision, name: 'Late rename', access: EVERYTHING_ACCESS });
    expect(result.ok === false && result.reason).toBe('stale');
    expect((await stored()).name).toBe(before.name);
  });

  it('reports a name already in use', async () => {
    const other = await createSavedView({ name: 'Taken name', tab: 'results', query: '' }, null);
    if (!other.ok) throw new Error('create failed');
    const result = await saveViewChanges({ viewId: id, revision: (await stored()).revision, name: 'taken name', access: EVERYTHING_ACCESS });
    expect(result).toEqual({ ok: false, reason: 'name-taken' });
  });

  it('writes nothing and keeps the revision when the changes leave the view as saved', async () => {
    const before = await stored();
    const result = await saveViewChanges({ viewId: id, revision: before.revision, changes: params('severity=critical'), access: EVERYTHING_ACCESS });
    expect(result.ok && result.changed).toEqual([]);
    expect(await stored()).toEqual(before);
  });

  it('answers stale over an older revision, writes nothing and hands back the view as it is now', async () => {
    const before = await stored();
    await updateSavedView(id, { name: 'Renamed by someone else' }, null);
    const result = await saveViewChanges({ viewId: id, revision: before.revision, changes: params('severity=low'), access: EVERYTHING_ACCESS });
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== 'stale') throw new Error('expected stale');
    expect(result.view.revision).toBe(before.revision + 1);
    expect((await stored()).query).toBe(before.query);
  });

  it('answers not-found for a view that is gone', async () => {
    const result = await saveViewChanges({ viewId: 'nope', revision: 1, changes: params(''), access: EVERYTHING_ACCESS });
    expect(result).toEqual({ ok: false, reason: 'not-found' });
  });

  it('refuses a value outside the saver\'s Access and counts it', async () => {
    const before = await stored();
    const result = await saveViewChanges({ viewId: id, revision: before.revision, changes: params(`subscription=${SUB_B},${SUB_D}`), access: L });
    expect(result).toEqual({ ok: false, reason: 'outside-access', count: 1 });
    expect(await stored()).toEqual(before);
  });

  it('does not count a held-back value the view already saved as one the saver added', async () => {
    const before = await stored();
    const result = await saveViewChanges({ viewId: id, revision: before.revision, changes: params(`subscription=${SUB_A},${SUB_B},${SUB_C}`), access: LC });
    expect(result.ok).toBe(true);
    expect(new URLSearchParams((await stored()).query).get('subscription')!.split(',').sort()).toEqual([SUB_A, SUB_B, SUB_C].sort());
  });

  it('refuses a value outside the saver\'s Access that the view did not save, even beside saved ones', async () => {
    const before = await stored();
    const result = await saveViewChanges({ viewId: id, revision: before.revision, changes: params(`subscription=${SUB_A},${SUB_B},${SUB_D}`), access: LC });
    expect(result).toEqual({ ok: false, reason: 'outside-access', count: 1 });
    expect(await stored()).toEqual(before);
  });

  it('refuses Any over saved values the saver does not hold', async () => {
    const before = await stored();
    const result = await saveViewChanges({ viewId: id, revision: before.revision, changes: params('subscription='), access: L });
    expect(result).toEqual({ ok: false, reason: 'any-over-held-back', dimensions: ['subscription'] });
    expect(await stored()).toEqual(before);
  });

  it('merges back the saved values the saver cannot see when they change that dimension', async () => {
    const other = await createSavedView({ name: `second ${crypto.randomUUID()}`, tab: 'results', query: `subscription=${SUB_A}%2C${SUB_B}` }, null);
    if (!other.ok) throw new Error('create failed');
    const result = await saveViewChanges({ viewId: other.view.id, revision: other.view.revision, changes: params(`subscription=${SUB_B}&severity=low`), access: L });
    expect(result.ok).toBe(true);
    const query = new URLSearchParams((await getSavedView(other.view.id))!.query);
    expect(query.get('subscription')!.split(',').sort()).toEqual([SUB_A, SUB_B].sort());
    expect(query.get('severity')).toBe('low');
  });

  it('keeps a dimension the saver did not touch as saved, held-back values included', async () => {
    const result = await saveViewChanges({ viewId: id, revision: (await stored()).revision, changes: params('severity=low'), access: L });
    expect(result.ok).toBe(true);
    expect(new URLSearchParams((await stored()).query).get('subscription')).toBe(`${SUB_A},${SUB_B}`);
  });

  it('does not let a stale write land when another save arrives between the check and the write', async () => {
    const before = await stored();
    const first = await saveViewChanges({ viewId: id, revision: before.revision, changes: params('severity=low'), access: EVERYTHING_ACCESS });
    const second = await saveViewChanges({ viewId: id, revision: before.revision, changes: params('severity=high'), access: EVERYTHING_ACCESS });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(new URLSearchParams((await stored()).query).get('severity')).toBe('low');
  });
});

describe('saving a new view with one open', () => {
  it('builds the view from the effective View', async () => {
    const result = await buildViewFromOpen({ viewId: id, revision: (await stored()).revision, changes: params('severity=high'), access: EVERYTHING_ACCESS });
    expect(result).toEqual({ ok: true, query: `severity=high&subscription=${SUB_A}%2C${SUB_B}`, dropped: 0 });
  });

  it('drops the values outside the saver\'s Access and counts them', async () => {
    const result = await buildViewFromOpen({ viewId: id, revision: (await stored()).revision, changes: params('severity=high'), access: L });
    expect(result).toEqual({ ok: true, query: `severity=high&subscription=${SUB_B}`, dropped: 1 });
  });

  it('says stale over an older revision', async () => {
    const before = await stored();
    await updateSavedView(id, { name: 'Renamed by someone else' }, null);
    const result = await buildViewFromOpen({ viewId: id, revision: before.revision, changes: params(''), access: L });
    expect(result.ok === false && result.reason).toBe('stale');
  });

  it('says not-found for a view that is gone', async () => {
    expect(await buildViewFromOpen({ viewId: 'nope', revision: 1, changes: params(''), access: L })).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('the repository\'s revision check', () => {
  it('refuses an older revision without writing', async () => {
    const before = await stored();
    const result = await updateSavedView(id, { name: 'Late rename' }, null, before.revision - 1);
    expect(result).toEqual({ ok: false, reason: 'stale', revision: before.revision });
    expect((await stored()).name).toBe(before.name);
  });
});
