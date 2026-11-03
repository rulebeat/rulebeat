/**
 * ADR 0012 (#352): every dashboard and saved view reads back with an owner, a visibility and a revision,
 * every insert path writes Shared explicitly, and every write moves the revision up by one. Runs on
 * whichever backend the suite is pointed at, through the repositories the app reads with.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { clearDashboards, execRaw, resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import {
  createDashboard, createStarterDashboard, deleteDashboard, duplicateDashboard,
  getDashboard, listDashboards, setDefaultDashboard, updateDashboard,
} from '@/lib/db/dashboards';
import { createSavedView, getSavedView, updateSavedView } from '@/lib/db/saved-views';
import type { DashboardConfig } from '@/lib/types';

const CONFIG: DashboardConfig = { widgets: [], filters: {} };

beforeEach(async () => {
  await resetDb();
  await clearDashboards();
});

async function newPerson(email: string, name: string | null) {
  const made = await createUser({ email, name: name ?? undefined, role: 'editor' });
  if (!('user' in made)) throw new Error(made.error);
  return made.user;
}

async function dashboard(name: string) {
  const made = await createDashboard({ name, config: CONFIG });
  if (!made.ok) throw new Error('create failed');
  return made.dashboard;
}

describe('dashboards', () => {
  it('are created Shared at revision 1 with no owner', async () => {
    expect(await dashboard('First')).toMatchObject({ owner: null, visibility: 'shared', revision: 1 });
  });

  it('are Shared at revision 1 with no owner when duplicated or restored from the starter', async () => {
    const first = await dashboard('First');
    expect(await duplicateDashboard(first.id)).toMatchObject({ owner: null, visibility: 'shared', revision: 1 });
    expect(await createStarterDashboard()).toMatchObject({ owner: null, visibility: 'shared', revision: 1 });
  });

  it('move up one revision on every update, and a failed update leaves it where it was', async () => {
    const first = await dashboard('First');
    await dashboard('Second');
    await updateDashboard(first.id, { description: 'a' });
    await updateDashboard(first.id, { config: { widgets: [], filters: { categories: ['cost'] } } });
    expect((await getDashboard(first.id))?.revision).toBe(3);

    expect(await updateDashboard(first.id, { name: 'second' })).toEqual({ ok: false, reason: 'name-taken' });
    expect((await getDashboard(first.id))?.revision).toBe(3);
  });

  it('move up one revision for each row whose default flag changes, and only those', async () => {
    const first = await dashboard('First');
    const second = await dashboard('Second');
    const third = await dashboard('Third');
    await setDefaultDashboard(second.id);

    const byId = Object.fromEntries((await listDashboards()).map(d => [d.id, d]));
    expect(byId[first.id]).toMatchObject({ isDefault: false, revision: 2 });
    expect(byId[second.id]).toMatchObject({ isDefault: true, revision: 2 });
    expect(byId[third.id]).toMatchObject({ isDefault: false, revision: 1 });
  });

  it('move up one revision when deleting the default promotes the oldest', async () => {
    const first = await dashboard('First');
    const second = await dashboard('Second');
    await deleteDashboard(first.id);
    expect(await getDashboard(second.id)).toMatchObject({ isDefault: true, revision: 2 });
  });

  it('read back the owner as the person is now, and none when the person is gone', async () => {
    const person = await newPerson('owner@example.com', 'Olive Owner');
    const first = await dashboard('First');
    await execRaw(`UPDATE dashboards SET owner_id = '${person.id}' WHERE id = '${first.id}'`);
    expect((await getDashboard(first.id))?.owner).toEqual({ id: person.id, displayName: 'Olive Owner', email: 'owner@example.com' });

    await execRaw(`UPDATE dashboards SET owner_id = 'removed-person' WHERE id = '${first.id}'`);
    expect((await getDashboard(first.id))?.owner).toBeNull();
  });
});

describe('saved views', () => {
  it('are created Shared at revision 1', async () => {
    const made = await createSavedView({ name: 'Critical', tab: 'results', query: 'severity=critical' }, null);
    if (!made.ok) throw new Error('create failed');
    expect(made.view).toMatchObject({ owner: null, visibility: 'shared', revision: 1 });
  });

  it('move up one revision on every update, and a refused rename leaves it where it was', async () => {
    const made = await createSavedView({ name: 'Critical', tab: 'results', query: 'severity=critical' }, null);
    const other = await createSavedView({ name: 'High', tab: 'results', query: 'severity=high' }, null);
    if (!made.ok || !other.ok) throw new Error('create failed');

    const first = await updateSavedView(made.view.id, { query: 'severity=high' }, null);
    if (!first.ok) throw new Error('update failed');
    expect(first.before.revision).toBe(1);
    expect(first.view.revision).toBe(2);

    expect(await updateSavedView(made.view.id, { name: 'high' }, null)).toEqual({ ok: false, reason: 'name-taken' });
    expect((await getSavedView(made.view.id))?.revision).toBe(2);
  });

  it('read back the owner as the person is now, and none when the person is gone', async () => {
    const person = await newPerson('viewer-owner@example.com', null);
    const made = await createSavedView({ name: 'Critical', tab: 'results', query: '' }, null);
    if (!made.ok) throw new Error('create failed');
    await execRaw(`UPDATE saved_views SET owner_id = '${person.id}' WHERE id = '${made.view.id}'`);
    // Until they first sign in a person has no name, so the email stands in for it.
    expect((await getSavedView(made.view.id))?.owner).toEqual({
      id: person.id, displayName: 'viewer-owner@example.com', email: 'viewer-owner@example.com',
    });

    await execRaw(`DELETE FROM users WHERE id = '${person.id}'`);
    expect((await getSavedView(made.view.id))?.owner).toBeNull();
  });
});
