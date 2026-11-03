/**
 * ADR 0012 (#355): the dashboard routes with an owner. Everything made is Personal and owned by the actor;
 * someone else's Personal dashboard answers like an unknown id, an Admin included; a Shared one is open to
 * everyone signed in and changed only by its owner or by someone who can manage Shared ones; Duplicate copies
 * neither default flag; and a Personal item is logged by id and kind, with no name.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDashboards, execRaw, resetDb } from '../helpers/db';
import { createUser, updateUserRole } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { listAllAuditEntries } from '@/lib/db/audit';
import { getDashboard, listDashboards } from '@/lib/db/dashboards';
import { STARTER_DASHBOARD } from '@/lib/dashboard-templates';
import type { Role } from '@/lib/rbac';
import type { Dashboard } from '@/lib/types';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const { GET: LIST, POST } = await import('@/app/api/dashboards/route');
const { GET: READ, PUT, DELETE } = await import('@/app/api/dashboards/[id]/route');
const { POST: DUPLICATE } = await import('@/app/api/dashboards/[id]/duplicate/route');

async function signInAs(role: Role): Promise<string> {
  const result = await createUser({ email: `${role}-${Math.random().toString(36).slice(2)}@example.com`, role });
  if ('error' in result) throw new Error(result.error);
  await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
  return result.user.id;
}

const json = (method: string, payload: unknown) =>
  new Request('http://localhost/api/dashboards', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (payload: unknown) => POST(json('POST', payload));
const put = (id: string, payload: unknown) => PUT(json('PUT', payload), ctx(id));
const read = (id: string) => READ(new Request('http://localhost/api/dashboards/x'), ctx(id));
const remove = (id: string) => DELETE(new Request('http://localhost/api/dashboards/x', { method: 'DELETE' }), ctx(id));
const duplicate = (id: string) => DUPLICATE(json('POST', {}), ctx(id));
const share = (id: string) => execRaw(`UPDATE dashboards SET visibility = 'shared' WHERE id = '${id}'`);
const disown = (id: string) => execRaw(`UPDATE dashboards SET owner_id = NULL WHERE id = '${id}'`);

async function created(name: string): Promise<Dashboard> {
  const res = await post({ name });
  expect(res.status).toBe(201);
  return await res.json() as Dashboard;
}

const names = async () => (await (await LIST()).json() as Dashboard[]).map(d => d.name).sort();
const auditText = async () => JSON.stringify((await listAllAuditEntries()).filter(e => e.entityType === 'dashboard').map(e => [e.summary, e.details]));

beforeEach(async () => {
  await resetDb();
  await clearDashboards();
  mockAuth.mockReset();
});

describe('new dashboards are Personal', () => {
  it('makes a Personal dashboard owned by the actor on create, for every Role', async () => {
    for (const role of ['viewer', 'editor', 'admin'] as Role[]) {
      const actor = await signInAs(role);
      expect(await created(`By ${role}`)).toMatchObject({ visibility: 'personal', owner: { id: actor }, isDefault: false });
    }
  });

  it('makes the first dashboard on the install a plain Personal one, never the default', async () => {
    await signInAs('admin');
    expect((await created('First')).isDefault).toBe(false);
    expect((await listDashboards()).filter(d => d.isDefault)).toEqual([]);
  });

  it('restores the starter as a Personal dashboard owned by the actor, for a Viewer too', async () => {
    const actor = await signInAs('viewer');
    const res = await post({ template: 'starter' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: STARTER_DASHBOARD.name, visibility: 'personal', owner: { id: actor }, isDefault: false });
  });

  it('makes a Personal copy owned by the copier on Duplicate, and copies neither default flag nor widget config', async () => {
    await signInAs('admin');
    const config = { autoRefresh: 0, widgets: [{ id: 'w', type: 'stat-card', title: 'T', x: 0, y: 0, w: 4, h: 2, config: { savedViewId: 'view-1' } }] };
    const source = await (await post({ name: 'Source', config })).json() as Dashboard;
    await share(source.id);
    expect((await put(source.id, { isDefault: true })).status).toBe(200);

    const copier = await signInAs('viewer');
    const res = await duplicate(source.id);
    expect(res.status).toBe(201);
    const copy = await res.json() as Dashboard;
    expect(copy).toMatchObject({ name: 'Source (copy)', visibility: 'personal', owner: { id: copier }, isDefault: false });
    expect(copy.config.widgets[0]!.config).toEqual({ savedViewId: 'view-1' });
    expect((await getDashboard(source.id))?.isDefault).toBe(true);
  });
});

describe('someone else\'s Personal dashboard', () => {
  it('answers like an unknown id on every path, an Admin included, and is left out of the list', async () => {
    await signInAs('editor');
    const theirs = await created('Theirs');
    await signInAs('admin');

    const unknown = [await read('nope'), await put('nope', { name: 'x' }), await remove('nope'), await duplicate('nope')];
    const stranger = [await read(theirs.id), await put(theirs.id, { name: 'x' }), await remove(theirs.id), await duplicate(theirs.id)];
    expect(stranger.map(r => r.status)).toEqual([404, 404, 404, 404]);
    expect(await Promise.all(stranger.map(r => r.json()))).toEqual(await Promise.all(unknown.map(r => r.json())));
    expect(await names()).toEqual([]);
    expect((await put(theirs.id, { isDefault: true })).status).toBe(404);
    expect((await getDashboard(theirs.id))?.name).toBe('Theirs');
  });
});

describe('Shared dashboards', () => {
  it('open for anyone signed in, including a Viewer, and a Viewer may Duplicate but not change one', async () => {
    await signInAs('editor');
    const shared = await created('Team view');
    await share(shared.id);

    await signInAs('viewer');
    expect(await names()).toEqual(['Team view']);
    expect((await read(shared.id)).status).toBe(200);
    expect((await put(shared.id, { name: 'Mine now' })).status).toBe(403);
    expect((await remove(shared.id)).status).toBe(403);
    expect((await duplicate(shared.id)).status).toBe(201);
  });

  it('are changed by their owner, and an Admin may change an ownerless one', async () => {
    await signInAs('editor');
    const shared = await created('Team view');
    await share(shared.id);
    expect((await put(shared.id, { name: 'Team view 2' })).status).toBe(200);

    await disown(shared.id);
    await signInAs('admin');
    expect((await put(shared.id, { name: 'Team view 3' })).status).toBe(200);
    expect((await remove(shared.id)).status).toBe(204);
  });

  it('keep a demoted owner\'s items stored: they still open and Duplicate their own Shared one but cannot change it', async () => {
    const owner = await signInAs('editor');
    const shared = await created('Was mine');
    await share(shared.id);
    expect(await updateUserRole(owner, 'viewer')).toMatchObject({ user: { role: 'viewer' } });

    expect((await read(shared.id)).status).toBe(200);
    expect((await duplicate(shared.id)).status).toBe(201);
    expect((await put(shared.id, { name: 'Still mine?' })).status).toBe(403);
    expect((await getDashboard(shared.id))?.name).toBe('Was mine');
  });

  it('are made the Install default only by someone who can manage Shared dashboards, and never a Personal one', async () => {
    await signInAs('editor');
    const personal = await created('Mine');
    expect((await put(personal.id, { isDefault: true })).status).toBe(400);
    await share(personal.id);
    expect((await put(personal.id, { isDefault: true })).status).toBe(200);
    expect((await getDashboard(personal.id))?.isDefault).toBe(true);

    await signInAs('viewer');
    expect((await put(personal.id, { isDefault: true })).status).toBe(403);
  });
});

describe('dashboard names', () => {
  it('answer 409 for a Personal name the owner already uses, whatever its case', async () => {
    await signInAs('viewer');
    await created('Overview');
    const res = await post({ name: '  OVERVIEW ' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('A dashboard named "OVERVIEW" already exists.');
  });

  it('never reveal or clash with another person\'s Personal names', async () => {
    await signInAs('editor');
    await created('Overview');
    await signInAs('viewer');
    expect((await post({ name: 'overview' })).status).toBe(201);
  });

  it('pick the next free copy name among the copier\'s own Personal names', async () => {
    await signInAs('editor');
    const shared = await created('Team view');
    await share(shared.id);
    await signInAs('viewer');
    await created('Team view (copy)');
    expect((await (await duplicate(shared.id)).json() as Dashboard).name).toBe('Team view (copy 2)');
    await signInAs('viewer');
    expect((await (await duplicate(shared.id)).json() as Dashboard).name).toBe('Team view (copy)');
  });
});

describe('audit', () => {
  it('logs a Personal create, rename and delete by id and kind, with no name', async () => {
    await signInAs('viewer');
    const made = await created('Quarterly numbers');
    await put(made.id, { name: 'Annual numbers' });
    await duplicate(made.id);
    await remove(made.id);
    expect((await post({ template: 'starter' })).status).toBe(201);

    const entries = (await listAllAuditEntries()).filter(e => e.entityType === 'dashboard');
    expect(entries.map(e => e.action).sort()).toEqual(['dashboard.create', 'dashboard.create', 'dashboard.delete', 'dashboard.duplicate', 'dashboard.rename']);
    const text = await auditText();
    for (const value of ['Quarterly', 'Annual', STARTER_DASHBOARD.name]) expect(text).not.toContain(value);
    expect(entries.find(e => e.action === 'dashboard.delete')?.entityId).toBe(made.id);
  });

  it('keeps naming a Shared dashboard in the log, as before', async () => {
    await signInAs('editor');
    const made = await created('Team view');
    await share(made.id);
    await put(made.id, { name: 'Team view 2' });
    expect(await auditText()).toContain('Team view 2');
  });
});
