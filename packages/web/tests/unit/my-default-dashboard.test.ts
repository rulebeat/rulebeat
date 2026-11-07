/**
 * My default (ADR 0012, #360): the dashboard a person opens first. `/dashboard` lands on it, then on the
 * Install default, then on `/dashboards`. A My default that stops being reachable (deleted, unshared by
 * someone else, or its owner removed) is cleared in the same transaction that made it unreachable, and the
 * person is told once, by a notice on the page the redirect lands on. The redirect never writes a choice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDashboards, execRaw, resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { listAllAuditEntries } from '@/lib/db/audit';
import { createDashboard, getDashboard } from '@/lib/db/dashboards';
import { getMyDefault } from '@/lib/db/default-dashboard';
import type { Role } from '@/lib/rbac';
import type { Dashboard } from '@/lib/types';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); },
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => '/dashboards',
  useSearchParams: () => new URLSearchParams(),
}));

const { PUT: SET_MINE } = await import('@/app/api/account/default-dashboard/route');
const { PUT: CHOOSE } = await import('@/app/api/dashboards/install-default/route');
const { DELETE, PUT } = await import('@/app/api/dashboards/[id]/route');
const { POST: UNSHARE } = await import('@/app/api/dashboards/[id]/unshare/route');
const { DELETE: REMOVE_USER } = await import('@/app/api/users/[id]/route');
const { default: LandingPage } = await import('@/app/(app)/dashboard/page');

const NOTICE = 'notice=default-dashboard-unavailable';

async function makeUser(role: Role): Promise<string> {
  const result = await createUser({ email: `${role}-${Math.random().toString(36).slice(2)}@example.com`, role });
  if ('error' in result) throw new Error(result.error);
  await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  return result.user.id;
}
const actAs = (id: string) => mockAuth.mockResolvedValue({ user: { uid: id } });

const json = (method: string, payload: unknown) =>
  new Request('http://localhost/api/x', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const setMine = (id: unknown) => SET_MINE(json('PUT', { id }));
const chooseInstall = (id: string) => CHOOSE(json('PUT', { id }));
const remove = (id: string) => DELETE(new Request('http://localhost/api/dashboards/x', { method: 'DELETE' }), ctx(id));
const unshare = (id: string) => UNSHARE(new Request('http://localhost/api/dashboards/x/unshare', { method: 'POST' }), ctx(id));
const share = (id: string) => execRaw(`UPDATE dashboards SET visibility = 'shared' WHERE id = '${id}'`);

async function dashboardOf(ownerId: string, name: string, shared = false): Promise<Dashboard> {
  const made = await createDashboard({ name, config: { autoRefresh: 0, widgets: [] } }, ownerId);
  if (!made.ok) throw new Error(made.reason);
  if (shared) await share(made.dashboard.id);
  return made.dashboard;
}

/** Where `/dashboard` sends the signed-in person. */
async function landing(): Promise<string> {
  try {
    await LandingPage();
  } catch (err) {
    const match = /^NEXT_REDIRECT:(.*)$/.exec((err as Error).message);
    if (match) return match[1]!;
    throw err;
  }
  throw new Error('the page did not redirect');
}

beforeEach(async () => {
  await resetDb();
  await clearDashboards();
  mockAuth.mockReset();
});

describe('PUT /api/account/default-dashboard', () => {
  it('accepts the person\'s own Personal dashboard, for every Role', async () => {
    for (const role of ['viewer', 'editor', 'admin'] as Role[]) {
      const me = await makeUser(role);
      actAs(me);
      const mine = await dashboardOf(me, `Mine ${role}`);
      expect((await setMine(mine.id)).status).toBe(200);
      expect(await getMyDefault(me)).toEqual({ dashboardId: mine.id, unavailable: false });
    }
  });

  it('accepts any Shared dashboard, someone else\'s included', async () => {
    const owner = await makeUser('editor');
    const shared = await dashboardOf(owner, 'Team', true);
    const me = await makeUser('viewer');
    actAs(me);
    expect((await setMine(shared.id)).status).toBe(200);
    expect((await getMyDefault(me)).dashboardId).toBe(shared.id);
  });

  it('answers someone else\'s Personal dashboard and an unknown id the same 404, and stores nothing', async () => {
    const owner = await makeUser('editor');
    const theirs = await dashboardOf(owner, 'Theirs');
    const me = await makeUser('admin');
    actAs(me);
    const stranger = await setMine(theirs.id);
    const unknown = await setMine('00000000-0000-0000-0000-00000000dead');
    expect(stranger.status).toBe(404);
    expect(await stranger.json()).toEqual(await unknown.json());
    expect((await getMyDefault(me)).dashboardId).toBeNull();
  });

  it('answers 400 without an id', async () => {
    actAs(await makeUser('viewer'));
    expect((await setMine(undefined)).status).toBe(400);
    expect((await setMine(7)).status).toBe(400);
  });

  it('clears the unavailable flag, and is not audited', async () => {
    const me = await makeUser('viewer');
    const first = await dashboardOf(me, 'First');
    const second = await dashboardOf(me, 'Second');
    actAs(me);
    await setMine(first.id);
    await remove(first.id);
    expect((await getMyDefault(me)).unavailable).toBe(true);

    expect((await setMine(second.id)).status).toBe(200);
    expect(await getMyDefault(me)).toEqual({ dashboardId: second.id, unavailable: false });
    expect((await listAllAuditEntries()).filter(e => e.action.includes('default'))).toEqual([]);
  });

  it('is not changed by choosing the Install default', async () => {
    const admin = await makeUser('admin');
    actAs(admin);
    const mine = await dashboardOf(admin, 'Mine');
    const team = await dashboardOf(admin, 'Team', true);
    await setMine(mine.id);
    await chooseInstall(team.id);
    expect((await getMyDefault(admin)).dashboardId).toBe(mine.id);
  });
});

describe('/dashboard', () => {
  it('goes to My default first', async () => {
    const admin = await makeUser('admin');
    const team = await dashboardOf(admin, 'Team', true);
    actAs(admin);
    await chooseInstall(team.id);
    const mine = await dashboardOf(admin, 'Mine');
    await setMine(mine.id);
    expect(await landing()).toBe(`/dashboards/${mine.id}`);
  });

  it('goes to the Install default when the person has no My default', async () => {
    const admin = await makeUser('admin');
    const team = await dashboardOf(admin, 'Team', true);
    actAs(admin);
    await chooseInstall(team.id);
    actAs(await makeUser('viewer'));
    expect(await landing()).toBe(`/dashboards/${team.id}`);
  });

  it('goes to /dashboards when there is neither, and never to the first dashboard it can open', async () => {
    const admin = await makeUser('admin');
    await dashboardOf(admin, 'Oldest', true);
    await dashboardOf(admin, 'Mine');
    actAs(admin);
    expect(await landing()).toBe('/dashboards');
  });

  it('does not write the person\'s choice when it falls back', async () => {
    const admin = await makeUser('admin');
    const team = await dashboardOf(admin, 'Team', true);
    actAs(admin);
    await chooseInstall(team.id);
    const me = await makeUser('viewer');
    actAs(me);
    await landing();
    expect(await getMyDefault(me)).toEqual({ dashboardId: null, unavailable: false });
  });

  it('sends a person who is signed out to sign in', async () => {
    mockAuth.mockResolvedValue(null);
    expect(await landing()).toBe('/signin');
  });
});

describe('a My default that becomes unreachable', () => {
  async function personWithShared(role: Role = 'viewer') {
    const owner = await makeUser('editor');
    const shared = await dashboardOf(owner, 'Team', true);
    const me = await makeUser(role);
    actAs(me);
    expect((await setMine(shared.id)).status).toBe(200);
    return { owner, shared, me };
  }

  it('is cleared with the flag set when its dashboard is deleted, for every person who had it', async () => {
    const { owner, shared, me } = await personWithShared();
    const other = await makeUser('viewer');
    actAs(other);
    await setMine(shared.id);

    actAs(owner);
    expect((await remove(shared.id)).status).toBe(204);
    expect(await getMyDefault(me)).toEqual({ dashboardId: null, unavailable: true });
    expect(await getMyDefault(other)).toEqual({ dashboardId: null, unavailable: true });
  });

  it('is cleared with the flag set when someone else unshares its dashboard, but not the owner\'s own', async () => {
    const owner = await makeUser('editor');
    const shared = await dashboardOf(owner, 'Team', true);
    actAs(owner);
    await setMine(shared.id);
    const me = await makeUser('viewer');
    actAs(me);
    await setMine(shared.id);

    actAs(await makeUser('admin'));
    expect((await unshare(shared.id)).status).toBe(200);
    expect(await getMyDefault(me)).toEqual({ dashboardId: null, unavailable: true });
    expect(await getMyDefault(owner)).toEqual({ dashboardId: shared.id, unavailable: false });
  });

  it('is cleared by the owner\'s own unshare for everyone else, who can no longer open it', async () => {
    const { owner, shared, me } = await personWithShared();
    actAs(owner);
    expect((await unshare(shared.id)).status).toBe(200);
    expect(await getMyDefault(me)).toEqual({ dashboardId: null, unavailable: true });
  });

  it('is cleared with the flag set when the removal of a person makes it unreachable', async () => {
    const admin = await makeUser('admin');
    const owner = await makeUser('editor');
    const theirs = await dashboardOf(owner, 'Theirs');
    const me = await makeUser('viewer');
    // A My default pointing at another person's Personal dashboard cannot be set through the route; it is
    // what an old row or a hand edit leaves behind, and the removal's sweep is what puts it right.
    await execRaw(`UPDATE users SET default_dashboard_id = '${theirs.id}' WHERE id = '${me}'`);
    actAs(admin);
    expect((await REMOVE_USER(new Request('http://localhost/api/users/x', { method: 'DELETE' }), ctx(owner))).status).toBe(200);
    expect(await getDashboard(theirs.id)).toBeNull();
    expect(await getMyDefault(me)).toEqual({ dashboardId: null, unavailable: true });
  });

  it('leaves a My default alone that stays reachable when its owner is removed', async () => {
    const admin = await makeUser('admin');
    const { owner, shared, me } = await personWithShared();
    actAs(admin);
    await REMOVE_USER(new Request('http://localhost/api/users/x', { method: 'DELETE' }), ctx(owner));
    expect(await getMyDefault(me)).toEqual({ dashboardId: shared.id, unavailable: false });
  });

  it('is not touched by a rename or any other save of its dashboard', async () => {
    const { owner, shared, me } = await personWithShared();
    actAs(owner);
    expect((await PUT(json('PUT', { name: 'Team 2' }), ctx(shared.id))).status).toBe(200);
    expect(await getMyDefault(me)).toEqual({ dashboardId: shared.id, unavailable: false });
  });

  it('is told once: /dashboard clears the flag, redirects with the notice, and the next visit has none', async () => {
    const admin = await makeUser('admin');
    const team = await dashboardOf(admin, 'Team', true);
    actAs(admin);
    await chooseInstall(team.id);
    const { owner, shared, me } = await personWithShared();
    actAs(owner);
    await remove(shared.id);

    actAs(me);
    expect(await landing()).toBe(`/dashboards/${team.id}?${NOTICE}`);
    expect(await getMyDefault(me)).toEqual({ dashboardId: null, unavailable: false });
    expect(await landing()).toBe(`/dashboards/${team.id}`);
  });

  it('puts the notice on /dashboards when there is no Install default either', async () => {
    const { owner, shared, me } = await personWithShared();
    actAs(owner);
    await remove(shared.id);
    actAs(me);
    expect(await landing()).toBe(`/dashboards?${NOTICE}`);
    expect(await landing()).toBe('/dashboards');
  });

  it('tells a person whose new My default was chosen after the loss nothing', async () => {
    const { owner, shared, me } = await personWithShared();
    actAs(owner);
    await remove(shared.id);
    actAs(me);
    const mine = await dashboardOf(me, 'Mine');
    await setMine(mine.id);
    expect(await landing()).toBe(`/dashboards/${mine.id}`);
  });
});
