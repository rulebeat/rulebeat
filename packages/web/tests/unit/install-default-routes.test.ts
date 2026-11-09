/**
 * The Install default (ADR 0012, #360): an Admin or an Editor on Everything chooses it from the Shared
 * dashboards, through its own route and never through a dashboard save. Only they may unshare or delete it;
 * its owner, an Editor on part of the install, still edits what is in it. Losing it (unshare or delete)
 * leaves the install with no default, and each of these changes is audited as `dashboard.install_default`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDashboards, execRaw, resetDb } from '../helpers/db';
import { MATRIX_TENANT, SCOPE_SUBSCRIPTION } from '../helpers/access-matrix';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { listAllAuditEntries } from '@/lib/db/audit';
import { getDashboard, listDashboards } from '@/lib/db/dashboards';
import { replaceAssignmentsOn } from '@/lib/db/role-assignments';
import { inTransaction } from '@/lib/db/exec';
import { everythingAccess } from '@/lib/access-model';
import { installDefaultControlFor } from '@/lib/write-controls';
import type { Role } from '@/lib/rbac';
import type { Dashboard } from '@/lib/types';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

// Runs once, right after a route has read the dashboard and before it changes it: the window another request
// can use to make the dashboard the Install default.
let afterRead: (() => Promise<void>) | null = null;
vi.mock('@/lib/db/dashboards', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/db/dashboards')>();
  return {
    ...real,
    getDashboard: async (id: string) => {
      const found = await real.getDashboard(id);
      const hook = afterRead;
      afterRead = null;
      await hook?.();
      return found;
    },
  };
});

const { PUT: CHOOSE } = await import('@/app/api/dashboards/install-default/route');
const { POST, GET: LIST } = await import('@/app/api/dashboards/route');
const { PUT, DELETE } = await import('@/app/api/dashboards/[id]/route');
const { POST: UNSHARE } = await import('@/app/api/dashboards/[id]/unshare/route');

async function signInAs(role: Role, options: { onOneSubscription?: boolean } = {}): Promise<string> {
  const result = await createUser({ email: `${role}-${Math.random().toString(36).slice(2)}@example.com`, role });
  if ('error' in result) throw new Error(result.error);
  await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  if (options.onOneSubscription) {
    await inTransaction(tx => replaceAssignmentsOn(tx, result.user.id, [{ tenantId: MATRIX_TENANT, scope: SCOPE_SUBSCRIPTION, role }]));
  }
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
  return result.user.id;
}
const actAs = (id: string) => mockAuth.mockResolvedValue({ user: { uid: id } });

const json = (method: string, payload: unknown) =>
  new Request('http://localhost/api/dashboards', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const choose = (id: unknown) => CHOOSE(json('PUT', { id }));
const put = (id: string, payload: unknown) => PUT(json('PUT', payload), ctx(id));
const remove = (id: string) => DELETE(new Request('http://localhost/api/dashboards/x', { method: 'DELETE' }), ctx(id));
const unshare = (id: string) => UNSHARE(new Request('http://localhost/api/dashboards/x/unshare', { method: 'POST' }), ctx(id));
const share = (id: string) => execRaw(`UPDATE dashboards SET visibility = 'shared' WHERE id = '${id}'`);

async function created(name: string, shared = false): Promise<Dashboard> {
  const res = await POST(json('POST', { name }));
  expect(res.status).toBe(201);
  const made = await res.json() as Dashboard;
  if (shared) await share(made.id);
  return made;
}

const installDefaultId = async () => (await listDashboards()).find(d => d.isInstallDefault)?.id ?? null;
const installDefaultAudit = async () => (await listAllAuditEntries()).filter(e => e.action === 'dashboard.install_default');

beforeEach(async () => {
  await resetDb();
  await clearDashboards();
  mockAuth.mockReset();
  afterRead = null;
});

describe('PUT /api/dashboards/install-default', () => {
  it('makes a Shared dashboard the Install default for an Admin, and moves it off the one before', async () => {
    await signInAs('admin');
    const first = await created('First', true);
    const second = await created('Second', true);
    expect((await choose(first.id)).status).toBe(200);
    expect(await installDefaultId()).toBe(first.id);

    const res = await choose(second.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: second.id, isInstallDefault: true });
    expect(await installDefaultId()).toBe(second.id);
    expect((await listDashboards()).filter(d => d.isInstallDefault)).toHaveLength(1);
  });

  it('answers in the held-back shape: counts, the asker\'s My default, and no marks on stored values', async () => {
    await signInAs('admin');
    const made = await created('Shape', true);
    const body = await (await choose(made.id)).json() as Record<string, unknown>;
    expect(body).toMatchObject({ id: made.id, isInstallDefault: true, isMyDefault: false, heldBack: [] });
    expect(body).not.toHaveProperty('outsideAccess');
  });

  it('works for an Editor on Everything', async () => {
    await signInAs('editor');
    const shared = await created('Team', true);
    expect((await choose(shared.id)).status).toBe(200);
    expect(await installDefaultId()).toBe(shared.id);
  });

  it('refuses a Personal dashboard with 409 and leaves the default as it was', async () => {
    await signInAs('admin');
    const shared = await created('Team', true);
    await choose(shared.id);
    const personal = await created('Mine');

    const res = await choose(personal.id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Shared/);
    expect(await installDefaultId()).toBe(shared.id);
    expect((await getDashboard(personal.id))?.isDefault).toBe(false);
  });

  it('answers someone else\'s Personal dashboard like an unknown id', async () => {
    await signInAs('editor');
    const theirs = await created('Theirs');
    await signInAs('admin');
    const stranger = await choose(theirs.id);
    const unknown = await choose('00000000-0000-0000-0000-00000000dead');
    expect(stranger.status).toBe(404);
    expect(await stranger.json()).toEqual(await unknown.json());
  });

  it('answers 400 without an id', async () => {
    await signInAs('admin');
    expect((await choose(undefined)).status).toBe(400);
    expect((await choose(42)).status).toBe(400);
  });

  it('is refused for a Viewer and for an Editor who holds only part of the install', async () => {
    await signInAs('editor');
    const shared = await created('Team', true);
    await signInAs('viewer');
    expect((await choose(shared.id)).status).toBe(403);
    await signInAs('editor', { onOneSubscription: true });
    expect((await choose(shared.id)).status).toBe(403);
    expect(await installDefaultId()).toBeNull();
  });

  it('is audited as dashboard.install_default, naming the dashboard', async () => {
    await signInAs('admin');
    const shared = await created('Team numbers', true);
    await choose(shared.id);
    const entries = await installDefaultAudit();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entityType: 'dashboard', entityId: shared.id });
    expect(entries[0]!.summary).toContain('Team numbers');
  });

  it('does not audit a refusal', async () => {
    await signInAs('admin');
    const personal = await created('Mine');
    await choose(personal.id);
    expect(await installDefaultAudit()).toEqual([]);
  });
});

describe('a dashboard save', () => {
  it('answers 400 when isDefault is sent, true or false, and changes nothing', async () => {
    await signInAs('admin');
    const shared = await created('Team', true);
    const before = await getDashboard(shared.id);
    expect((await put(shared.id, { isDefault: true })).status).toBe(400);
    expect((await put(shared.id, { isDefault: false, name: 'Renamed' })).status).toBe(400);
    expect(await getDashboard(shared.id)).toEqual(before);
  });
});

describe('the protected Install default', () => {
  async function ownedByScopedEditor() {
    const owner = await signInAs('editor', { onOneSubscription: true });
    const made = await created('Owned default');
    await share(made.id);
    await execRaw(`UPDATE dashboards SET is_default = TRUE WHERE id = '${made.id}'`);
    return { owner, id: made.id };
  }

  it('cannot be unshared or deleted by its owner who holds only part of the install, who can still edit it', async () => {
    const { id } = await ownedByScopedEditor();
    expect((await unshare(id)).status).toBe(403);
    expect((await remove(id)).status).toBe(403);
    expect((await put(id, { name: 'Owned default 2' })).status).toBe(200);
    expect(await getDashboard(id)).toMatchObject({ name: 'Owned default 2', visibility: 'shared', isInstallDefault: true });
  });

  it('is unshared or deleted by an Admin or an Editor on Everything', async () => {
    const { id } = await ownedByScopedEditor();
    await signInAs('admin');
    expect((await unshare(id)).status).toBe(200);

    const second = await created('Second', true);
    await choose(second.id);
    await signInAs('editor');
    expect((await remove(second.id)).status).toBe(204);
  });

  it('is not protected once it is not the default', async () => {
    const owner = await signInAs('editor', { onOneSubscription: true });
    const made = await created('Not default', true);
    actAs(owner);
    expect((await unshare(made.id)).status).toBe(200);
  });

  it('gives the screens a disabled control and a reason from the server, for whoever may not manage', () => {
    expect(installDefaultControlFor(everythingAccess('admin', 'manual'))).toEqual({ allowed: true });
    expect(installDefaultControlFor(everythingAccess('editor', 'manual'))).toEqual({ allowed: true });
    const viewer = installDefaultControlFor(everythingAccess('viewer', 'manual'));
    expect(viewer.allowed).toBe(false);
    expect(viewer.reason).toMatch(/Admin|Everything/);
  });
});

describe('an Install default chosen between a route\'s read and its change', () => {
  const makeDefault = (id: string) => async () => { await execRaw(`UPDATE dashboards SET is_default = TRUE WHERE id = '${id}'`); };

  it('still cannot be deleted or unshared by its owner who holds only part of the install', async () => {
    const owner = await signInAs('editor', { onOneSubscription: true });
    const toDelete = await created('To delete', true);
    const toUnshare = await created('To unshare', true);
    actAs(owner);

    afterRead = makeDefault(toDelete.id);
    expect((await remove(toDelete.id)).status).toBe(403);
    expect(await getDashboard(toDelete.id)).toMatchObject({ isInstallDefault: true });

    afterRead = makeDefault(toUnshare.id);
    expect((await unshare(toUnshare.id)).status).toBe(403);
    expect(await getDashboard(toUnshare.id)).toMatchObject({ visibility: 'shared', isInstallDefault: true });
  });

  it('is audited as dashboard.install_default when an Admin deletes or unshares it', async () => {
    await signInAs('admin');
    const toDelete = await created('To delete', true);
    const toUnshare = await created('To unshare', true);

    afterRead = makeDefault(toDelete.id);
    expect((await remove(toDelete.id)).status).toBe(204);
    afterRead = makeDefault(toUnshare.id);
    expect((await unshare(toUnshare.id)).status).toBe(200);
    expect((await installDefaultAudit()).map(e => e.entityId).sort()).toEqual([toDelete.id, toUnshare.id].sort());
  });
});

describe('losing the Install default', () => {
  it('leaves no default after a delete, promotes nothing, and is audited', async () => {
    await signInAs('admin');
    const older = await created('Older', true);
    const chosen = await created('Chosen', true);
    await choose(chosen.id);

    expect((await remove(chosen.id)).status).toBe(204);
    expect(await installDefaultId()).toBeNull();
    expect((await listDashboards()).map(d => d.id)).toEqual([older.id]);
    const entries = await installDefaultAudit();
    expect(entries).toHaveLength(2);
    expect(entries[entries.length - 1]).toMatchObject({ entityId: chosen.id });
  });

  it('leaves no default after an unshare, promotes nothing, and is audited', async () => {
    await signInAs('admin');
    const other = await created('Other', true);
    const chosen = await created('Chosen', true);
    await choose(chosen.id);

    expect((await unshare(chosen.id)).status).toBe(200);
    expect(await installDefaultId()).toBeNull();
    expect((await getDashboard(other.id))?.isDefault).toBe(false);
    expect(await installDefaultAudit()).toHaveLength(2);
  });

  it('writes no install default entry when the dashboard was not the default', async () => {
    await signInAs('admin');
    const plain = await created('Plain', true);
    await remove(plain.id);
    expect(await installDefaultAudit()).toEqual([]);
  });

  it('shows the Install default in the list', async () => {
    await signInAs('admin');
    const shared = await created('Team', true);
    await choose(shared.id);
    const listed = await (await LIST()).json() as Dashboard[];
    expect(listed.find(d => d.id === shared.id)).toMatchObject({ isInstallDefault: true });
  });
});
