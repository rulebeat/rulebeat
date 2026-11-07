/**
 * ADR 0012 (#355): what the dashboard and saved view repositories do with an owner. Creating, duplicating
 * and restoring the starter make a Personal item owned by the person; a Personal name is unique among that
 * person's Personal items only; a Shared name among Shared items; no name check reads another person's
 * Personal names; and nothing becomes the Install default by being first or the oldest left.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { clearDashboards, execRaw, resetDb } from '../helpers/db';
import { createUser, deleteUser } from '@/lib/db/users';
import {
  createDashboard, createStarterDashboard, deleteDashboard, duplicateDashboard,
  getDashboard, listDashboards, setDefaultDashboard, updateDashboard,
} from '@/lib/db/dashboards';
import { createSavedView, deleteSavedView, getSavedView, listSavedViews, updateSavedView } from '@/lib/db/saved-views';
import { countOwnedItems } from '@/lib/db/item-owners';
import { STARTER_DASHBOARD } from '@/lib/dashboard-templates';
import type { DashboardConfig } from '@/lib/types';

const CONFIG: DashboardConfig = { widgets: [], filters: {} };

let ana: string;
let ben: string;

async function person(email: string): Promise<string> {
  const made = await createUser({ email, role: 'viewer' });
  if (!('user' in made)) throw new Error(made.error);
  return made.user.id;
}

beforeEach(async () => {
  await resetDb();
  await clearDashboards();
  ana = await person('ana@example.com');
  ben = await person('ben@example.com');
});

async function dashboard(name: string, owner: string) {
  const made = await createDashboard({ name, config: CONFIG }, owner);
  if (!made.ok) throw new Error(`create failed: ${made.reason}`);
  return made.dashboard;
}

const share = (table: 'dashboards' | 'saved_views', id: string) => execRaw(`UPDATE ${table} SET visibility = 'shared' WHERE id = '${id}'`);

describe('dashboards', () => {
  it('are created Personal, owned by the person, and the first one is not the default', async () => {
    const first = await dashboard('First', ana);
    expect(first).toMatchObject({ visibility: 'personal', owner: { id: ana }, isDefault: false });
  });

  it('keep a Personal name unique among that person\'s Personal items, ignoring case and spaces', async () => {
    await dashboard('Overview', ana);
    expect(await createDashboard({ name: '  OVERVIEW ', config: CONFIG }, ana)).toEqual({ ok: false, reason: 'name-taken' });
  });

  it('never read another person\'s Personal names, nor a Shared name, when a Personal item is created', async () => {
    const anas = await dashboard('Overview', ana);
    expect((await createDashboard({ name: 'overview', config: CONFIG }, ben)).ok).toBe(true);

    await share('dashboards', anas.id);
    expect((await createDashboard({ name: 'Overview', config: CONFIG }, ana)).ok).toBe(true);
  });

  it('check a Shared rename against Shared names install-wide, and never against another person\'s Personal names', async () => {
    const a = await dashboard('Alpha', ana);
    const b = await dashboard('Beta', ben);
    await share('dashboards', a.id);
    await dashboard('Gamma', ben);

    expect(await updateDashboard(a.id, { name: 'gamma' })).toMatchObject({ ok: true });
    await share('dashboards', b.id);
    expect(await updateDashboard(a.id, { name: ' BETA ' })).toEqual({ ok: false, reason: 'name-taken' });
  });

  it('check a Personal rename against the owner\'s other Personal items only', async () => {
    const a = await dashboard('Alpha', ana);
    await dashboard('Beta', ana);
    await dashboard('Gamma', ben);
    expect(await updateDashboard(a.id, { name: 'gamma' })).toMatchObject({ ok: true });
    expect(await updateDashboard(a.id, { name: 'beta' })).toEqual({ ok: false, reason: 'name-taken' });
  });

  it('keep an existing clashing pair working: saving one without renaming it', async () => {
    const a = await dashboard('Alpha', ana);
    await execRaw(`INSERT INTO dashboards (id, name, config, is_default, created_at, owner_id, visibility, revision) VALUES ('twin', 'ALPHA', '{"widgets":[]}', FALSE, '2024-01-01T00:00:00.000Z', '${ana}', 'personal', 1)`);
    expect(await updateDashboard(a.id, { description: 'edited' })).toMatchObject({ ok: true });
    expect(await updateDashboard('twin', { name: 'alpha' })).toMatchObject({ ok: true });
  });

  it('are duplicated as a Personal copy owned by the copier, without a default flag and with widget config intact', async () => {
    const config: DashboardConfig = { widgets: [{ id: 'w', type: 'summary', x: 0, y: 0, w: 2, h: 2, config: { savedViewId: 'view-1' } }] } as unknown as DashboardConfig;
    const source = await createDashboard({ name: 'Source', config }, ana);
    if (!source.ok) throw new Error('create failed');
    await share('dashboards', source.dashboard.id);
    await setDefaultDashboard(source.dashboard.id);

    const copy = await duplicateDashboard(source.dashboard.id, ben);
    expect(copy).toMatchObject({ name: 'Source (copy)', visibility: 'personal', owner: { id: ben }, isDefault: false });
    expect(copy?.config).toEqual(config);
    expect((await getDashboard(source.dashboard.id))?.isDefault).toBe(true);
  });

  it('pick the next free copy name among the copier\'s Personal names only', async () => {
    const source = await dashboard('Source', ana);
    await share('dashboards', source.id);
    await dashboard('Source (copy)', ben);
    await dashboard('Source (copy 2)', ana);

    expect((await duplicateDashboard(source.id, ana))?.name).toBe('Source (copy)');
    expect((await duplicateDashboard(source.id, ben))?.name).toBe('Source (copy 2)');
  });

  it('restore the starter as a Personal item owned by the person, named against their Personal names', async () => {
    const first = await createStarterDashboard(ana);
    expect(first).toMatchObject({ name: STARTER_DASHBOARD.name, visibility: 'personal', owner: { id: ana }, isDefault: false });
    expect((await createStarterDashboard(ana)).name).toBe(`${STARTER_DASHBOARD.name} (2)`);
    expect((await createStarterDashboard(ben)).name).toBe(STARTER_DASHBOARD.name);
  });

  it('leave no default when the default is deleted: nothing is promoted for being the oldest', async () => {
    const a = await dashboard('Alpha', ana);
    const b = await dashboard('Beta', ana);
    await share('dashboards', a.id);
    await share('dashboards', b.id);
    await setDefaultDashboard(a.id);
    await deleteDashboard(a.id);
    expect((await listDashboards()).filter(d => d.isDefault)).toEqual([]);
  });
});

describe('saved views', () => {
  const FIELDS = { tab: 'results', query: 'severity=critical' } as const;

  async function view(name: string, owner: string) {
    const made = await createSavedView({ name, ...FIELDS }, owner);
    if (!made.ok) throw new Error(`create failed: ${made.reason}`);
    return made.view;
  }

  it('are created Personal and owned by the person', async () => {
    expect(await view('Critical', ana)).toMatchObject({ visibility: 'personal', owner: { id: ana }, createdBy: ana });
  });

  it('keep a Personal name unique among that person\'s Personal views only', async () => {
    await view('Critical', ana);
    expect(await createSavedView({ name: ' critical ', ...FIELDS }, ana)).toEqual({ ok: false, reason: 'name-taken' });
    expect((await createSavedView({ name: 'critical', ...FIELDS }, ben)).ok).toBe(true);
  });

  it('check a Shared rename against Shared names, and never against another person\'s Personal names', async () => {
    const a = await view('Alpha', ana);
    const b = await view('Beta', ben);
    await share('saved_views', a.id);
    expect((await updateSavedView(a.id, { name: 'beta' }, ana)).ok).toBe(true);

    const c = await view('Third', ana);
    await share('saved_views', c.id);
    await share('saved_views', b.id);
    expect(await updateSavedView(c.id, { name: ' BETA' }, ana)).toEqual({ ok: false, reason: 'name-taken' });
  });

  it('check a Personal rename against the owner\'s other Personal views only', async () => {
    const a = await view('Alpha', ana);
    await view('Beta', ana);
    await view('Gamma', ben);
    expect((await updateSavedView(a.id, { name: 'gamma' }, ana)).ok).toBe(true);
    expect(await updateSavedView(a.id, { name: 'beta' }, ana)).toEqual({ ok: false, reason: 'name-taken' });
  });
});

describe('removing a person', () => {
  it('deletes their Personal dashboards and views and leaves their Shared ones Shared with no owner, in one count', async () => {
    const keptDashboard = await dashboard('Kept', ana);
    await share('dashboards', keptDashboard.id);
    await dashboard('Gone', ana);
    const othersDashboard = await dashboard('Bens', ben);
    const keptView = await createSavedView({ name: 'Kept', tab: 'results', query: '' }, ana);
    const goneView = await createSavedView({ name: 'Gone', tab: 'results', query: '' }, ana);
    const othersView = await createSavedView({ name: 'Bens', tab: 'results', query: '' }, ben);
    if (!keptView.ok || !goneView.ok || !othersView.ok) throw new Error('create failed');
    await share('saved_views', keptView.view.id);

    expect(await countOwnedItems(ana)).toEqual({ personalDashboards: 1, sharedDashboards: 1, personalViews: 1, sharedViews: 1 });
    expect(await deleteUser(ana)).toMatchObject({ withdrawnRequests: 0, dashboards: { deleted: 1, released: 1 }, views: { deleted: 1, released: 1 } });

    expect((await getDashboard(keptDashboard.id))).toMatchObject({ visibility: 'shared', owner: null });
    expect((await listDashboards()).map(d => d.name).sort()).toEqual(['Bens', 'Kept']);
    expect(await getSavedView(keptView.view.id)).toMatchObject({ visibility: 'shared', owner: null });
    expect(await getSavedView(goneView.view.id)).toBeNull();
    expect((await listSavedViews()).map(v => v.name).sort()).toEqual(['Bens', 'Kept']);
    expect((await getDashboard(othersDashboard.id))?.owner?.id).toBe(ben);
    expect(await deleteSavedView(othersView.view.id)).not.toBeNull();
  });
});
