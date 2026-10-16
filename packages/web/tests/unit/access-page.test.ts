/**
 * The Access page and the user routes it drives. The page has its own gate, separate from the routes'
 * guards: a Viewer or Editor who opens /access is shown their own access, read-only, and is never handed
 * the user list or the password ids, and every verb on /api/users that reads or writes someone else's
 * access answers 403.
 *
 * Driven from the page's default export and the routes' real handlers, with only the session and the
 * Azure tenant id (the one thing a test never reads from Azure) mocked.
 */
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUser, getUser, listUsers, recordMirrorFailure, setManualAccess, setMirroredAccess, type AppUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { listAllAuditEntries } from '@/lib/db/audit';
import { deleteAssignmentsOn, listAssignmentsFor, replaceAssignmentsOn } from '@/lib/db/role-assignments';
import { inTransaction } from '@/lib/db/exec';
import { listUsersWithAccess, type AppUserWithAccess, type OwnAccess } from '@/lib/access';
import { describeAccess } from '@/lib/access-model';
import { UsersSection } from '@/app/(app)/access/users-section';
import { OwnAccessSection } from '@/app/(app)/access/own-access-section';
import { ScopePicker } from '@/app/(app)/access/scope-picker';
import { LinkedAccountFields } from '@/app/(app)/access/mirrored-access-form';
import { MirroredDetail } from '@/app/(app)/access/mirrored-detail';
import { LAST_ADMIN_NOTE, PersonClient } from '@/app/(app)/access/person-client';
import { ScopeTree } from '@/components/scope-tree';
import { hierarchyItems } from '@/lib/scope-tree';
import type { MirroredScope } from '@/lib/access-mirror-model';
import { AzureNotConfiguredError } from '@/lib/azure-credential';
import { NO_AZURE_CONNECTION_MESSAGE, UNKNOWN_MANAGEMENT_GROUP_MESSAGE } from '@/lib/manual-access';
import { hashPassword } from '@/lib/password';
import type { Role } from '@/lib/rbac';
import { resetDb } from '../helpers/db';
import { ManagementGroupsSection } from '@/app/(app)/access/management-groups-section';
import {
  demotedWithoutAccessMessage, demoteToMirrored, EDIT_STOPS_MIRROR_NOTE, editSaveRequest, grantsOfAccess, heldRows, type DemoteFetch,
} from '@/lib/access-picker';
import {
  fakeRoleAssignments, ACCOUNT, MG_EXAMPLE as MIRROR_MG, SUB_A as MIRROR_SUB, type FakeRoleAssignments,
} from '../helpers/fake-role-assignments';
import { refreshManagementGroupHierarchy } from '@/lib/management-group-hierarchy';
import { fakeHierarchy, group, refreshFrom, subscription } from '../helpers/fake-hierarchy';

const TENANT = '00000000-0000-0000-0000-0000000000f0';
const SUB = '/subscriptions/00000000-0000-0000-0000-00000000000a';
const OTHER_SUB = '/subscriptions/00000000-0000-0000-0000-00000000000b';
const RG = `${SUB}/resourceGroups/rg-one`;
const MG = '/providers/Microsoft.Management/managementGroups/mg-example';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

// The person page's client pushes back to the list on Save; notFound stays real, since the pages are tested by it.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
}));

const mockTenant = vi.fn();
vi.mock('@/lib/arm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/arm')>()),
  getArmTenantId: () => mockTenant(),
}));

// The two reads the page must not make for a person who manages no one: the real functions, counted.
vi.mock('@/lib/access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/access')>();
  return { ...actual, listUsersWithAccess: vi.fn(actual.listUsersWithAccess) };
});
vi.mock('@/lib/db/local-accounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/local-accounts')>();
  return { ...actual, listUserIdsWithPassword: vi.fn(actual.listUserIdsWithPassword) };
});
const { listUserIdsWithPassword } = await import('@/lib/db/local-accounts');

// Everything of the mirror but the Azure read is real: it runs over whatever `azure` holds, and never waits for real.
let azure: FakeRoleAssignments;
vi.mock('@/lib/access-mirror', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/access-mirror')>();
  const deps = () => ({ read: azure.read, wait: async () => undefined });
  return {
    ...actual,
    mirrorAccount: (objectId: string) => actual.mirrorAccount(objectId, deps()),
    refreshMirroredUser: (user: AppUser) => actual.refreshMirroredUser(user, deps()),
  };
});

const { default: AccessPage } = await import('@/app/(app)/access/page');
const { default: PersonPage } = await import('@/app/(app)/access/users/[id]/page');
const { default: NewPersonPage } = await import('@/app/(app)/access/users/new/page');
const usersRoute = await import('@/app/api/users/route');
const userRoute = await import('@/app/api/users/[id]/route');
const accessRoute = await import('@/app/api/users/[id]/access/route');
const ownAccessRoute = await import('@/app/api/access/route');
const passwordRoute = await import('@/app/api/users/[id]/password/route');
const mirrorRoute = await import('@/app/api/users/[id]/mirror/route');

async function makeUser(email: string, role: Role): Promise<AppUser> {
  const result = await createUser({ email, role });
  if ('error' in result) throw new Error(result.error);
  return result.user;
}

function signInAs(user: AppUser) {
  mockAuth.mockResolvedValue({ user: { uid: user.id } });
}

/** The props of the first element in a page's tree that has `marker` among them. */
function propsWith(node: ReactNode, marker: string): Record<string, unknown> {
  const queue: ReactNode[] = [node];
  while (queue.length > 0) {
    const next = queue.shift();
    if (Array.isArray(next)) { queue.push(...next); continue; }
    if (!isValidElement(next)) continue;
    const props = (next as ReactElement<Record<string, unknown>>).props;
    if (marker in props) return props;
    queue.push(props.children as ReactNode);
  }
  throw new Error(`${marker} not rendered`);
}
const accessClientProps = (node: ReactNode) => propsWith(node, 'initialUsers');

function jsonRequest(method: string, body: unknown): Request {
  return new Request('http://localhost/api/test', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const grant = (scope: string, role: 'viewer' | 'editor') => ({ scope, role });
const EVERYTHING_AT_VIEWER = [grant('/', 'viewer')];
/** Rows in the order `.sort()` gives, which is the order the tests read them back in. */
const sorted = <T>(rows: T[]): T[] => [...rows].sort();
const getRequest = () => new Request('http://localhost/api/test');

let admin: AppUser;
let target: AppUser;

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  mockTenant.mockReset();
  mockTenant.mockResolvedValue(TENANT);
  vi.mocked(listUserIdsWithPassword).mockClear();
  vi.mocked(listUsersWithAccess).mockClear();
  azure = fakeRoleAssignments({ assignments: [{ objectId: ACCOUNT, scope: MIRROR_SUB, role: 'Reader' }, { objectId: ACCOUNT, scope: MIRROR_MG, role: 'Contributor' }] });
  admin = await makeUser('admin@example.com', 'admin');
  target = await makeUser('target@example.com', 'viewer');
});

describe('the Access page', () => {
  it('is not found with no session', async () => {
    mockAuth.mockResolvedValue(null);
    await expect(AccessPage()).rejects.toMatchObject({ digest: expect.stringContaining('404') });
  });

  it('hands an admin the seeded users and the ids that have a local password', async () => {
    await setPassword(target.id, await hashPassword('a-genuinely-strong-pass!'), { mustChangePassword: false });
    signInAs(admin);

    const props = accessClientProps(await AccessPage());

    expect((props.initialUsers as AppUser[]).map(u => u.email).sort())
      .toEqual(['admin@example.com', 'target@example.com']);
    expect(props.initialUsersWithPassword).toEqual([target.id]);
    expect(props.currentUserId).toBe(admin.id);
    expect(props.demo).toBe(false);
  });

  describe.each(['viewer', 'editor'] as const)('for a %s', (role) => {
    let person: AppUser;
    beforeEach(async () => {
      person = await makeUser(`${role}@example.com`, role);
      await inTransaction(tx => replaceAssignmentsOn(tx, person.id, [
        { tenantId: TENANT, scope: SUB, role },
        { tenantId: TENANT, scope: `${OTHER_SUB}/resourceGroups/rg-two`, role: 'viewer' },
        { tenantId: TENANT, scope: '@directory', role },
      ]));
      signInAs(person);
    });

    it('shows their own Scopes, the Role at each and the source, and no other person\'s data', async () => {
      const page = await AccessPage();
      const own = propsWith(page, 'own').own as OwnAccess;
      expect(own.role).toBe(role);
      expect(own.source).toBe('manual');
      expect(own.scopes.map(s => [s.path, s.role]).sort()).toEqual(sorted([
        ['@directory', role], [`${OTHER_SUB}/resourceGroups/rg-two`, 'viewer'], [SUB, role],
      ]));

      const html = renderToStaticMarkup(createElement(OwnAccessSection, { own }));
      expect(html).toContain('Your access');
      expect(html).toContain('Chosen by an Admin');
      expect(html).toContain('Directory');
      expect(html).toContain('rg-two');
      expect(html).not.toContain('admin@example.com');
      expect(html).not.toContain('target@example.com');
      expect(() => accessClientProps(page)).toThrow('initialUsers not rendered');
    });

    it('shows no control at all', () => {
      const html = renderToStaticMarkup(createElement(OwnAccessSection, {
        own: { role, source: 'manual', scopes: [{ kind: 'subscription', path: SUB, role }], mirror: null },
      }));
      expect(html).not.toMatch(/<(button|input|select|textarea|a )/);
    });

    it('never loads the user list or the ids that have a local password', async () => {
      await AccessPage();
      expect(listUsersWithAccess).not.toHaveBeenCalled();
      expect(listUserIdsWithPassword).not.toHaveBeenCalled();
    });
  });

  it('tells a person who holds no Scope that they have been given no access, and why a list is empty', async () => {
    const person = await makeUser('nobody@example.com', 'viewer');
    await inTransaction(tx => deleteAssignmentsOn(tx, person.id));
    signInAs(person);
    const own = propsWith(await AccessPage(), 'own').own as OwnAccess;
    expect(own.scopes).toEqual([]);
    const html = renderToStaticMarkup(createElement(OwnAccessSection, { own }));
    expect(html).toContain('You have been given no access');
    expect(html).toContain('Ask an Admin');
  });

  it('loads the user list and password ids for an admin', async () => {
    signInAs(admin);
    await AccessPage();
    expect(listUsersWithAccess).toHaveBeenCalledTimes(1);
    expect(listUserIdsWithPassword).toHaveBeenCalledTimes(1);
  });
});

describe('the own-access route', () => {
  it.each(['viewer', 'editor'] as const)('answers a %s with their own access and nobody else\'s', async (role) => {
    const person = await makeUser(`${role}@example.com`, role);
    await inTransaction(tx => replaceAssignmentsOn(tx, person.id, [{ tenantId: TENANT, scope: RG, role }]));
    signInAs(person);
    const res = await ownAccessRoute.GET();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ role, source: 'manual', scopes: [{ kind: 'resourceGroup', path: RG, role }], mirror: null });
    expect(text).not.toContain(TENANT);
    expect(text).not.toContain('target@example.com');
  });

  it('answers an admin with Everything and no source', async () => {
    signInAs(admin);
    expect(await (await ownAccessRoute.GET()).json()).toEqual({
      role: 'admin', source: null, scopes: [{ kind: 'everything', path: '/', role: 'admin' }], mirror: null,
    });
  });

  it('answers 401 with no session', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await ownAccessRoute.GET()).status).toBe(401);
  });
});

describe.each(['viewer', 'editor'] as const)('the user routes for a %s', (role) => {
  beforeEach(async () => {
    signInAs(await makeUser(`${role}@example.com`, role));
  });

  it('refuses GET and POST /api/users', async () => {
    expect((await usersRoute.GET()).status).toBe(403);
    expect((await usersRoute.POST(jsonRequest('POST', { email: 'new@example.com', role: 'viewer', access: EVERYTHING_AT_VIEWER }))).status).toBe(403);
    expect((await listUsers()).map(u => u.email)).not.toContain('new@example.com');
  });

  it('refuses PUT and DELETE /api/users/[id]', async () => {
    expect((await userRoute.PUT(jsonRequest('PUT', { role: 'admin' }), params(target.id))).status).toBe(403);
    expect((await userRoute.DELETE(jsonRequest('DELETE', {}), params(target.id))).status).toBe(403);
    expect((await getUser(target.id))!.role).toBe('viewer');
  });

  it('refuses any read or write of another person\'s access', async () => {
    expect((await accessRoute.GET(getRequest(), params(target.id))).status).toBe(403);
    const write = await accessRoute.PUT(jsonRequest('PUT', { access: [grant('@directory', 'viewer')] }), params(target.id));
    expect(write.status).toBe(403);
    expect(await listAssignmentsFor(target.id)).toEqual([{ userId: target.id, tenantId: '', scope: '/', role: 'viewer', origin: null }]);
  });

  it('refuses a person\'s own Manual access too: only an Admin changes it', async () => {
    const self = (await listUsers()).find(u => u.email === `${role}@example.com`)!;
    expect((await accessRoute.PUT(jsonRequest('PUT', { access: [grant('/', 'editor')] }), params(self.id))).status).toBe(403);
  });

  it('refuses PUT and DELETE /api/users/[id]/password', async () => {
    expect((await passwordRoute.PUT(jsonRequest('PUT', { password: 'a-genuinely-strong-pass!' }), params(target.id))).status).toBe(403);
    expect((await passwordRoute.DELETE(jsonRequest('DELETE', {}), params(target.id))).status).toBe(403);
    expect((await getUser(target.id))!.sessionEpoch).toBe(0);
  });
});

describe('the user routes for an admin', () => {
  beforeEach(() => signInAs(admin));

  it('invites a user by email with a role and the Scopes chosen for them', async () => {
    const res = await usersRoute.POST(jsonRequest('POST', { email: 'invited@example.com', role: 'editor', access: [grant(SUB, 'editor')] }));
    expect(res.status).toBe(201);
    expect((await listUsers()).find(u => u.email === 'invited@example.com')?.role).toBe('editor');
  });

  it('changes a role', async () => {
    const res = await userRoute.PUT(jsonRequest('PUT', { role: 'editor' }), params(target.id));
    expect(res.status).toBe(200);
    expect((await getUser(target.id))!.role).toBe('editor');
  });

  it('removes a user', async () => {
    const res = await userRoute.DELETE(jsonRequest('DELETE', {}), params(target.id));
    expect(res.status).toBe(200);
    expect(await getUser(target.id)).toBeNull();
  });

  it('refuses to demote the only admin', async () => {
    const res = await userRoute.PUT(jsonRequest('PUT', { role: 'viewer', access: EVERYTHING_AT_VIEWER }), params(admin.id));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await getUser(admin.id))!.role).toBe('admin');
  });
});

describe('access in the page and the routes (#269)', () => {
  // Entries not seen yet, so the order of same-millisecond rows never matters.
  const seen = new Set<string>();
  const lastAudit = async (action: string) => {
    const fresh = (await listAllAuditEntries()).filter(e => e.action === action && !seen.has(e.id));
    fresh.forEach(e => seen.add(e.id));
    expect(fresh).toHaveLength(1);
    return fresh[0];
  };

  beforeEach(() => signInAs(admin));

  it('hands the client each person with the Access they resolve to', async () => {
    const props = accessClientProps(await AccessPage());
    const users = props.initialUsers as AppUserWithAccess[];
    const label = (email: string) => describeAccess(users.find(u => u.email === email)!.access);
    expect(label('admin@example.com')).toBe('Everything');
    expect(label('target@example.com')).toBe('Everything, manual');
  });

  it('renders "Everything, manual" for an upgraded Viewer and an Editor, and "Everything" for an Admin', async () => {
    await makeUser('editor@example.com', 'editor');
    const users = (accessClientProps(await AccessPage()).initialUsers) as AppUserWithAccess[];
    const html = renderToStaticMarkup(
      createElement(UsersSection, { initialUsers: users, initialUsersWithPassword: [], currentUserId: admin.id }),
    );
    expect(html).toContain('>Access</th>');
    // Each person's access is one line under their name; the Admin alone reads a bare "Everything".
    expect(html.match(/>Everything, manual<\/span>/g)).toHaveLength(2);
    expect(html.match(/>Everything<\/span>/g)).toHaveLength(1);
  });

  it('reads a short non-blank label for a person who holds no Scope', async () => {
    const empty = (await listUsersWithAccess()).find(u => u.id === target.id)!;
    await inTransaction(tx => deleteAssignmentsOn(tx, target.id));
    const none = (await listUsersWithAccess()).find(u => u.id === target.id)!;
    expect(describeAccess(empty.access)).toBe('Everything, manual');
    expect(describeAccess(none.access)).toBe('No access, manual');
    expect(describeAccess(none.access).trim()).not.toBe('');
  });

  it('GET /api/users returns each person with their access', async () => {
    const body = await (await usersRoute.GET()).json() as AppUserWithAccess[];
    expect(body.map(u => [u.email, describeAccess(u.access)]).sort()).toEqual([
      ['admin@example.com', 'Everything'],
      ['target@example.com', 'Everything, manual'],
    ]);
  });

  it('shows an invite, a Role change and a demotion without a reload: the responses carry the access', async () => {
    const invited = await (await usersRoute.POST(jsonRequest('POST', { email: 'invited@example.com', role: 'editor', access: [grant('/', 'editor')] }))).json() as AppUserWithAccess;
    expect(describeAccess(invited.access)).toBe('Everything, manual');
    expect(invited.access.grants.map(g => g.role)).toEqual(['editor']);

    const promoted = await (await userRoute.PUT(jsonRequest('PUT', { role: 'admin' }), params(target.id))).json() as AppUserWithAccess;
    expect(describeAccess(promoted.access)).toBe('Everything');

    const demoted = await (await userRoute.PUT(jsonRequest('PUT', { role: 'viewer', access: EVERYTHING_AT_VIEWER }), params(target.id))).json() as AppUserWithAccess;
    expect(describeAccess(demoted.access)).toBe('Everything, manual');
    expect(demoted.access.grants.map(g => g.role)).toEqual(['viewer']);
  });

  it('inviting a Viewer or Editor stores the Scopes chosen, and an Admin gets none', async () => {
    for (const role of ['viewer', 'editor'] as const) {
      const res = await usersRoute.POST(jsonRequest('POST', { email: `${role}-new@example.com`, role, access: [grant('/', role)] }));
      const created = await res.json() as AppUserWithAccess;
      expect(await listAssignmentsFor(created.id), role).toEqual([{ userId: created.id, tenantId: '', scope: '/', role, origin: null }]);
    }
    const created = await (await usersRoute.POST(jsonRequest('POST', { email: 'admin-new@example.com', role: 'admin' }))).json() as AppUserWithAccess;
    expect(await listAssignmentsFor(created.id)).toEqual([]);
  });

  it('promoting to Admin removes the rows', async () => {
    await userRoute.PUT(jsonRequest('PUT', { role: 'admin' }), params(target.id));
    expect(await listAssignmentsFor(target.id)).toEqual([]);
    expect((await getUser(target.id))!.accessSource).toBeNull();
  });

  it('removing a person removes their rows', async () => {
    await userRoute.DELETE(jsonRequest('DELETE', {}), params(target.id));
    expect(await listAssignmentsFor(target.id)).toEqual([]);
  });

  it('writes field names only into the invite and Role change audit entries', async () => {
    await usersRoute.POST(jsonRequest('POST', { email: 'invited@example.com', role: 'editor', access: [grant(SUB, 'editor')] }));
    const invite = await lastAudit('user.invite');
    expect(invite?.details).toEqual({ changed: ['role', 'accessSource', 'assignments'] });

    await userRoute.PUT(jsonRequest('PUT', { role: 'editor' }), params(target.id));
    const change = await lastAudit('user.role_change');
    expect(change?.details).toEqual({ changed: ['role', 'assignments'] });
    expect(change?.summary).toBe('Changed target@example.com from viewer to editor');

    await userRoute.PUT(jsonRequest('PUT', { role: 'admin' }), params(target.id));
    expect((await lastAudit('user.role_change'))?.details).toEqual({ changed: ['role', 'accessSource', 'assignments'] });

    for (const entry of await listAllAuditEntries()) {
      const text = JSON.stringify(entry.details ?? {});
      expect(text, entry.action).not.toMatch(/viewer|editor|admin|\/subscriptions|0000/);
    }
  });

  it('writes the names of the access fields a removal takes away into its audit entry (#267, story 25)', async () => {
    await userRoute.DELETE(jsonRequest('DELETE', {}), params(target.id));
    expect((await lastAudit('user.remove'))?.details).toEqual({ changed: ['role', 'accessSource', 'assignments'] });

    const mirrored = await makeUser('mirrored@example.com', 'viewer');
    await setMirroredAccess(mirrored.id, {
      role: 'viewer', tenantId: TENANT, objectId: '00000000-0000-0000-0000-0000000000c1', scopes: [{ scope: SUB, origins: [] }], at: '2026-06-02T00:00:00.000Z',
    });
    await userRoute.DELETE(jsonRequest('DELETE', {}), params(mirrored.id));
    expect((await lastAudit('user.remove'))?.details).toEqual({ changed: ['role', 'accessSource', 'assignments', 'linkedAccount'] });

    const second = await makeUser('second-admin@example.com', 'admin');
    await userRoute.DELETE(jsonRequest('DELETE', {}), params(second.id));
    expect((await lastAudit('user.remove'))?.details).toEqual({ changed: ['role'] });

    for (const entry of (await listAllAuditEntries()).filter(e => e.action === 'user.remove')) {
      expect(JSON.stringify(entry.details ?? {})).not.toMatch(/viewer|editor|admin|\/subscriptions|0000/);
    }
  });
});

describe('Manual access (#272)', () => {
  beforeEach(() => signInAs(admin));

  const put = (id: string, body: unknown) => accessRoute.PUT(jsonRequest('PUT', body), params(id));
  const rowsOf = async (id: string) => (await listAssignmentsFor(id)).map(r => [r.tenantId, r.scope, r.role]).sort();

  it('sets a Viewer\'s access to a list of Scopes and reads it back', async () => {
    const res = await put(target.id, { access: [
      grant('/', 'viewer'), grant('@directory', 'viewer'), grant(SUB, 'viewer'), grant(RG, 'editor'),
    ] });
    expect(res.status).toBe(200);

    expect(await rowsOf(target.id)).toEqual(sorted([
      ['', '/', 'viewer'], [TENANT, '@directory', 'viewer'], [TENANT, RG, 'editor'], [TENANT, SUB, 'viewer'],
    ]));
    const stored = await getUser(target.id);
    expect(stored).toMatchObject({ accessSource: 'manual', role: 'editor' });

    const back = await (await accessRoute.GET(getRequest(), params(target.id))).json() as AppUserWithAccess;
    expect(back.access.grants.map(g => [g.scope.path, g.role]).sort()).toEqual(sorted([
      ['/', 'viewer'], ['@directory', 'viewer'], [RG, 'editor'], [SUB, 'viewer'],
    ]));
    expect(back.access.source).toBe('manual');
  });

  it('works for an Editor, and gives them the highest Role among the rows, a Viewer when they hold none', async () => {
    const editor = await makeUser('editor@example.com', 'editor');
    await put(editor.id, { access: [grant(SUB, 'viewer')] });
    expect((await getUser(editor.id))!.role).toBe('viewer');
    await put(editor.id, { access: [grant(SUB, 'viewer'), grant(RG, 'editor')] });
    expect((await getUser(editor.id))!.role).toBe('editor');
    await put(editor.id, { access: [] });
    expect(await rowsOf(editor.id)).toEqual([]);
    expect((await getUser(editor.id))!.role).toBe('viewer');
  });

  it('replaces the whole list, not adds to it', async () => {
    await put(target.id, { access: [grant(SUB, 'viewer'), grant(RG, 'viewer')] });
    await put(target.id, { access: [grant('@directory', 'viewer')] });
    expect(await rowsOf(target.id)).toEqual([[TENANT, '@directory', 'viewer']]);
  });

  it('saves in one transaction: a save that fails part-way leaves what the person held', async () => {
    await put(target.id, { access: [grant(SUB, 'editor')] });
    // The second row cannot be stored (no Role), after the first row is written and the old ones are deleted.
    await expect(setManualAccess(target.id, [
      { tenantId: TENANT, scope: '@directory', role: 'viewer' },
      { tenantId: TENANT, scope: RG, role: null as never },
    ])).rejects.toThrow();
    expect(await rowsOf(target.id)).toEqual([[TENANT, SUB, 'editor']]);
    expect(await getUser(target.id)).toMatchObject({ role: 'editor', accessSource: 'manual' });
  });

  it('stores a Scope listed twice, in any casing, once at the higher Role', async () => {
    await put(target.id, { access: [grant(SUB, 'viewer'), grant(SUB.toUpperCase(), 'editor'), grant('/', 'viewer'), grant('/', 'editor')] });
    expect(await rowsOf(target.id)).toEqual(sorted([['', '/', 'editor'], [TENANT, SUB, 'editor']]));
  });

  it('resolves the tenant id on the server and never reads one from the request', async () => {
    await put(target.id, { tenantId: 'from-the-body', access: [{ scope: SUB, role: 'viewer', tenantId: 'also-from-the-body' }, grant('/', 'viewer')] });
    expect(await rowsOf(target.id)).toEqual(sorted([['', '/', 'viewer'], [TENANT, SUB, 'viewer']]));
    expect(mockTenant).toHaveBeenCalledTimes(1);
  });

  it('keeps the Everything tenant id on Everything, and needs no Azure connection for it', async () => {
    mockTenant.mockRejectedValue(new AzureNotConfiguredError('not connected'));
    const res = await put(target.id, { access: [grant('/', 'editor')] });
    expect(res.status).toBe(200);
    expect(await rowsOf(target.id)).toEqual([['', '/', 'editor']]);
  });

  it('refuses a subscription, resource group or the Directory with no Azure connection, with a stable message, and changes nothing', async () => {
    mockTenant.mockRejectedValue(new AzureNotConfiguredError('RuleBeat has no Azure credential to scan with.'));
    for (const scope of [SUB, RG, '@directory']) {
      const res = await put(target.id, { access: [grant(scope, 'viewer')] });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: NO_AZURE_CONNECTION_MESSAGE });
    }
    expect(await rowsOf(target.id)).toEqual([['', '/', 'viewer']]);
  });

  it('does not let a failure to read the tenant reach the browser', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockTenant.mockRejectedValue(new Error('AADSTS7000215: tenant 00000000-aaaa secret leaked'));
    const res = await put(target.id, { access: [grant(SUB, 'viewer')] });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/AADSTS|secret|00000000/);
    quiet.mockRestore();
  });

  describe('refuses, with a 400 and a stable message', () => {
    const refusals: [string, unknown, string][] = [
      ['a path that is not a Scope', [grant('not-a-scope', 'viewer')], 'A scope must be Everything, the Directory, a management group, a subscription or a resource group.'],
      ['a resource-level path', [grant(`${RG}/providers/Microsoft.Compute/virtualMachines/vm-one`, 'viewer')], 'A scope must be Everything, the Directory, a management group, a subscription or a resource group.'],
      ['a management group the loaded tree does not hold', [grant(MG, 'viewer')], UNKNOWN_MANAGEMENT_GROUP_MESSAGE],
      ['the Admin Role on a row', [{ scope: SUB, role: 'admin' }], 'The Admin Role cannot be given at a scope.'],
      ['a Role that does not exist', [{ scope: SUB, role: 'owner' }], 'Choose Viewer or Editor for each scope.'],
      ['a body that is not a list', { access: 'everything' }, 'Access must be a list of scopes.'],
    ];
    for (const [name, access, message] of refusals) {
      it(name, async () => {
        const res = await put(target.id, { access });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: message });
        expect(await rowsOf(target.id)).toEqual([['', '/', 'viewer']]);
      });
    }

    it('setting access on an Admin', async () => {
      const res = await put(admin.id, { access: [grant(SUB, 'viewer')] });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'An Admin has access to everything. Demote them first to choose their access.' });
      expect(await listAssignmentsFor(admin.id)).toEqual([]);
      expect((await getUser(admin.id))!.accessSource).toBeNull();
    });
  });

  it('answers 404 for a person who does not exist', async () => {
    expect((await put('00000000-0000-0000-0000-000000000099', { access: [] })).status).toBe(404);
  });

  it('writes one audit entry for a change, holding field names only', async () => {
    await put(target.id, { access: [grant(SUB, 'editor'), grant(RG, 'viewer')] });
    const entries = (await listAllAuditEntries()).filter(e => e.action === 'user.access_change');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.details).toEqual({ changed: ['role', 'assignments'] });
    const text = JSON.stringify(entries[0]);
    expect(text).not.toMatch(/subscriptions|0000|viewer"|editor"|@directory/);
  });

  describe('an invite', () => {
    it('without access is refused with a 400 and creates no user', async () => {
      for (const body of [
        { email: 'invited@example.com', role: 'viewer' },
        { email: 'invited@example.com', role: 'editor', access: [] },
        { email: 'invited@example.com', role: 'viewer', access: null },
      ]) {
        const res = await usersRoute.POST(jsonRequest('POST', body));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'Choose what this person can access.' });
      }
      expect((await listUsers()).map(u => u.email)).not.toContain('invited@example.com');
      expect((await listAllAuditEntries()).filter(e => e.action === 'user.invite')).toEqual([]);
    });

    it('with a Scope that cannot be stored is refused and creates no user', async () => {
      for (const access of [[grant(MG, 'viewer')], [{ scope: SUB, role: 'admin' }], [grant('nope', 'viewer')]]) {
        expect((await usersRoute.POST(jsonRequest('POST', { email: 'invited@example.com', role: 'viewer', access }))).status).toBe(400);
      }
      expect((await listUsers()).map(u => u.email)).not.toContain('invited@example.com');
    });

    it('with no Azure connection is refused for a subscription and creates no user', async () => {
      mockTenant.mockRejectedValue(new AzureNotConfiguredError('not connected'));
      const res = await usersRoute.POST(jsonRequest('POST', { email: 'invited@example.com', role: 'viewer', access: [grant(SUB, 'viewer')] }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: NO_AZURE_CONNECTION_MESSAGE });
      expect((await listUsers()).map(u => u.email)).not.toContain('invited@example.com');
    });

    it('stores the Scopes chosen under the server\'s tenant, and the highest Role on the person', async () => {
      const res = await usersRoute.POST(jsonRequest('POST', {
        email: 'invited@example.com', role: 'viewer', access: [{ scope: SUB, role: 'viewer', tenantId: 'x' }, grant(RG, 'editor')],
      }));
      expect(res.status).toBe(201);
      const created = await res.json() as AppUserWithAccess;
      expect(await rowsOf(created.id)).toEqual(sorted([[TENANT, RG, 'editor'], [TENANT, SUB, 'viewer']]));
      expect(created).toMatchObject({ role: 'editor', accessSource: 'manual' });
    });

    it('for an Admin takes no access', async () => {
      const res = await usersRoute.POST(jsonRequest('POST', { email: 'boss@example.com', role: 'admin', access: [grant(SUB, 'viewer')] }));
      expect(res.status).toBe(400);
      expect((await listUsers()).map(u => u.email)).not.toContain('boss@example.com');
    });

    it('writes one audit entry holding field names only', async () => {
      await usersRoute.POST(jsonRequest('POST', { email: 'invited@example.com', role: 'viewer', access: [grant(SUB, 'viewer')] }));
      const entries = (await listAllAuditEntries()).filter(e => e.action === 'user.invite');
      expect(entries).toHaveLength(1);
      expect(entries[0]!.details).toEqual({ changed: ['role', 'accessSource', 'assignments'] });
      expect(JSON.stringify(entries[0]!.details)).not.toMatch(/subscriptions|0000|viewer|editor/);
    });
  });

  describe('demoting an Admin', () => {
    let second: AppUser;
    beforeEach(async () => { second = await makeUser('second@example.com', 'admin'); });

    it('without access is refused with a 400 and leaves them an Admin', async () => {
      const res = await userRoute.PUT(jsonRequest('PUT', { role: 'editor' }), params(second.id));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Choose what this person can access.' });
      expect((await getUser(second.id))!.role).toBe('admin');
      expect(await listAssignmentsFor(second.id)).toEqual([]);
    });

    it('with Everything, which the page preselects, gives that Everything row at the new Role', async () => {
      const res = await userRoute.PUT(jsonRequest('PUT', { role: 'editor', access: [grant('/', 'editor')] }), params(second.id));
      expect(res.status).toBe(200);
      expect(await listAssignmentsFor(second.id)).toEqual([{ userId: second.id, tenantId: '', scope: '/', role: 'editor', origin: null }]);
      expect((await getUser(second.id))).toMatchObject({ role: 'editor', accessSource: 'manual' });
    });

    it('with Scopes of their own gives those rows, under the server\'s tenant', async () => {
      await userRoute.PUT(jsonRequest('PUT', { role: 'viewer', access: [grant(SUB, 'viewer'), grant('@directory', 'viewer')] }), params(second.id));
      expect(await rowsOf(second.id)).toEqual(sorted([[TENANT, '@directory', 'viewer'], [TENANT, SUB, 'viewer']]));
    });

    it('with a Scope that cannot be stored is refused and leaves them an Admin', async () => {
      const res = await userRoute.PUT(jsonRequest('PUT', { role: 'viewer', access: [grant(MG, 'viewer')] }), params(second.id));
      expect(res.status).toBe(400);
      expect((await getUser(second.id))!.role).toBe('admin');
    });

    it('writes one audit entry holding field names only', async () => {
      await userRoute.PUT(jsonRequest('PUT', { role: 'viewer', access: [grant(SUB, 'viewer')] }), params(second.id));
      const entries = (await listAllAuditEntries()).filter(e => e.action === 'user.role_change');
      expect(entries).toHaveLength(1);
      expect(entries[0]!.details).toEqual({ changed: ['role', 'accessSource', 'assignments'] });
      expect(JSON.stringify(entries[0]!.details)).not.toMatch(/subscriptions|0000|viewer|editor|admin/);
    });
  });

  describe('a Role change that is not a demotion', () => {
    it('is refused when it carries access, which belongs to the access route', async () => {
      const res = await userRoute.PUT(jsonRequest('PUT', { role: 'editor', access: [grant('/', 'editor')] }), params(target.id));
      expect(res.status).toBe(400);
      expect((await getUser(target.id))!.role).toBe('viewer');
    });

    it('sets that Role on every Scope the person holds', async () => {
      await put(target.id, { access: [grant(SUB, 'viewer'), grant('@directory', 'editor')] });
      await userRoute.PUT(jsonRequest('PUT', { role: 'viewer' }), params(target.id));
      expect((await rowsOf(target.id)).map(r => r[2])).toEqual(['viewer', 'viewer']);
    });
  });

  it('promoting to Admin drops every row and clears the source, with one audit entry of names only', async () => {
    await put(target.id, { access: [grant(SUB, 'viewer'), grant('@directory', 'viewer')] });
    await userRoute.PUT(jsonRequest('PUT', { role: 'admin' }), params(target.id));
    expect(await listAssignmentsFor(target.id)).toEqual([]);
    expect((await getUser(target.id))!.accessSource).toBeNull();
    const entries = (await listAllAuditEntries()).filter(e => e.action === 'user.role_change');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.details).toEqual({ changed: ['role', 'accessSource', 'assignments'] });
  });
});

/** The person page's client as it first renders, for `user` (null to add someone). */
function personMarkup(user: AppUserWithAccess | null, opts: { isLastAdmin?: boolean; signInTenantIsAzureTenant?: boolean } = {}): string {
  return renderToStaticMarkup(createElement(PersonClient, {
    user, isLastAdmin: opts.isLastAdmin ?? false, isSelf: false, signInTenantIsAzureTenant: opts.signInTenantIsAzureTenant ?? false, demo: false,
  }));
}

/** Each radio of one group on the person page: its label, and whether it is checked or disabled. */
function choicesIn(html: string, name: 'role' | 'access') {
  const radio = new RegExp(`<input type="radio"([^>]*name="${name}"[^>]*)>(?:(?!</label>)[\\s\\S])*?font-medium text-ink">([^<]+)</span>`, 'g');
  return [...html.matchAll(radio)].map(m => ({ label: m[2]!, checked: /checked=""/.test(m[1]!), disabled: /disabled=""/.test(m[1]!) }));
}
const checkedIn = (html: string, name: 'role' | 'access') => choicesIn(html, name).filter(c => c.checked).map(c => c.label);

/** Whether the page's Save (or Add user) button is disabled. */
const saveDisabled = (html: string, label: 'Save' | 'Add user') =>
  new RegExp(`<button[^>]*disabled=""[^>]*>(?:(?!</button>)[\\s\\S])*${label}</button>`).test(html);

describe('the add user page (#311)', () => {
  it('starts as a Viewer with no access chosen, and cannot be submitted until an email and a choice are given (#267, story 19)', () => {
    const html = personMarkup(null);
    expect(html).toContain('Work email');
    expect(checkedIn(html, 'role')).toEqual(['Viewer']);
    expect(choicesIn(html, 'access').map(c => c.label)).toEqual(['Everything', 'Selected Scopes', 'Mirrored from Azure']);
    expect(checkedIn(html, 'access')).toEqual([]);
    expect(html).toContain('Until you do, this person is given nothing');
    // No Scope list and no Linked account field until a choice is made.
    expect(html).not.toContain('Nothing is chosen yet');
    expect(html).not.toContain('linked-account-new');
    expect(saveDisabled(html, 'Add user')).toBe(true);
    expect(html).toContain('Enter a work email.');
  });

  it('is for an Admin only, and hands the form no one', async () => {
    signInAs(admin);
    expect(propsWith(await NewPersonPage(), 'isLastAdmin').user).toBeNull();
    signInAs(target);
    await expect(NewPersonPage()).rejects.toMatchObject({ digest: expect.stringContaining('404') });
    mockAuth.mockResolvedValue(null);
    await expect(NewPersonPage()).rejects.toMatchObject({ digest: expect.stringContaining('404') });
  });
});

describe('setManualAccess', () => {
  it('refuses an Admin, who is never scoped, and a person who does not exist', async () => {
    expect(await setManualAccess(admin.id, [])).toBe('admin');
    expect(await setManualAccess('00000000-0000-0000-0000-000000000099', [])).toBe('notfound');
  });
});

describe('the person page (#311)', () => {
  const personProps = async (id: string) => propsWith(await PersonPage(params(id)), 'isLastAdmin');
  const withAccessOf = async (id: string) => (await listUsersWithAccess()).find(u => u.id === id)!;

  it('hands an Admin the person with their access, and whether they are the last Admin or the Admin themselves', async () => {
    signInAs(admin);
    const props = await personProps(target.id);
    expect((props.user as AppUserWithAccess).email).toBe('target@example.com');
    expect((props.user as AppUserWithAccess).access).toBeDefined();
    expect(props.isLastAdmin).toBe(false);
    expect(props.isSelf).toBe(false);
    const own = await personProps(admin.id);
    expect(own.isLastAdmin).toBe(true);
    expect(own.isSelf).toBe(true);
    await makeUser('second@example.com', 'admin');
    expect((await personProps(admin.id)).isLastAdmin).toBe(false);
  });

  it('is not found for a person who does not exist, or with no session', async () => {
    signInAs(admin);
    await expect(PersonPage(params('00000000-0000-0000-0000-000000000099'))).rejects.toMatchObject({ digest: expect.stringContaining('404') });
    mockAuth.mockResolvedValue(null);
    await expect(PersonPage(params(target.id))).rejects.toMatchObject({ digest: expect.stringContaining('404') });
  });

  it.each(['viewer', 'editor'] as const)('shows a %s their own access read-only, and anyone else\'s as not found', async (role) => {
    const person = await makeUser(`${role}@example.com`, role);
    signInAs(person);
    const page = await PersonPage(params(person.id));
    expect(propsWith(page, 'own').own).toMatchObject({ role });
    expect(() => propsWith(page, 'isLastAdmin')).toThrow('isLastAdmin not rendered');
    await expect(PersonPage(params(admin.id))).rejects.toMatchObject({ digest: expect.stringContaining('404') });
    await expect(PersonPage(params(target.id))).rejects.toMatchObject({ digest: expect.stringContaining('404') });
  });

  it('sets the Role in one place, three choices, and offers no access choice for an Admin', async () => {
    const second = await makeUser('second@example.com', 'admin');
    const html = personMarkup(await withAccessOf(second.id));
    expect(choicesIn(html, 'role').map(c => c.label)).toEqual(['Viewer', 'Editor', 'Admin']);
    expect(checkedIn(html, 'role')).toEqual(['Admin']);
    expect(html).toContain('An Admin has access to everything, so there is no access to choose.');
    expect(choicesIn(html, 'access')).toEqual([]);
    expect(saveDisabled(html, 'Save')).toBe(true);
    expect(html).toContain('Nothing has changed.');
  });

  it('keeps the last Admin an Admin: the other Roles are disabled, and the page says why', async () => {
    const html = personMarkup(await withAccessOf(admin.id), { isLastAdmin: true });
    expect(choicesIn(html, 'role').filter(c => c.disabled).map(c => c.label)).toEqual(['Viewer', 'Editor']);
    expect(html).toContain(LAST_ADMIN_NOTE);
    expect(personMarkup(await withAccessOf(admin.id))).not.toContain(LAST_ADMIN_NOTE);
  });

  it('opens a person who holds only Everything on Everything, with no Scope list', async () => {
    await setManualAccess(target.id, [{ tenantId: '', scope: '/', role: 'editor' }]);
    const html = personMarkup(await withAccessOf(target.id));
    expect(checkedIn(html, 'access')).toEqual(['Everything']);
    expect(html).not.toContain('aria-label="Chosen Scopes"');
  });

  it('opens a person with Manual access on Selected Scopes, each listed with a remove control and no Role of its own', async () => {
    await setManualAccess(target.id, [
      { tenantId: TENANT, scope: SUB, role: 'viewer' },
      { tenantId: TENANT, scope: `${OTHER_SUB}/resourceGroups/rg-two`, role: 'viewer' },
    ]);
    const html = personMarkup(await withAccessOf(target.id));
    expect(checkedIn(html, 'access')).toEqual(['Selected Scopes']);
    expect(html).toContain('aria-label="Chosen Scopes"');
    expect(html).toContain('aria-label="Remove 00000000-0000-0000-0000-00000000000a"');
    expect(html).toContain('aria-label="Remove rg-two"');
    expect(html).toContain('in 00000000-0000-0000-0000-00000000000b');
    expect(html).not.toContain('Different Role here');
    expect(html).not.toMatch(/<select/);
    expect(html).not.toContain('at different Roles');
    expect(saveDisabled(html, 'Save')).toBe(true);
    expect(html).toContain('Nothing has changed.');
  });

  it('says when Scopes are held at different Roles, and that saving gives them all the Role chosen', async () => {
    await setManualAccess(target.id, [
      { tenantId: TENANT, scope: SUB, role: 'viewer' },
      { tenantId: TENANT, scope: OTHER_SUB, role: 'editor' },
    ]);
    const html = personMarkup(await withAccessOf(target.id));
    expect(html).toContain('This person holds Scopes at different Roles. Saving gives every Scope the Role above, Editor.');
    // Saving would change them, so Save is on.
    expect(saveDisabled(html, 'Save')).toBe(false);
  });

  it('lists a held management group the tree no longer has, so it can be removed (#307)', async () => {
    signInAs(admin);
    const fake = fakeHierarchy([group(TENANT, 'Tenant Root Group', null), group('mg-example', 'Example group', TENANT)]);
    await refreshFrom(fake);
    await accessRoute.PUT(jsonRequest('PUT', { access: [grant(MG, 'viewer')] }), params(target.id));
    fake.nodes = [group(TENANT, 'Tenant Root Group', null)];
    await refreshFrom(fake);
    expect(personMarkup(await withAccessOf(target.id))).toContain('aria-label="Remove mg-example"');
  });

  it('tells an Admin when a person was given nothing, without a Scope list to read it from', async () => {
    await setManualAccess(target.id, []);
    const html = personMarkup(await withAccessOf(target.id));
    expect(html).toContain('Nothing is chosen, so this person will see no findings until an Admin gives them access.');
  });
});

describe('Management group Scopes (#273)', () => {
  const put = (id: string, body: unknown) => accessRoute.PUT(jsonRequest('PUT', body), params(id));
  const rowsOf = async (id: string) => (await listAssignmentsFor(id)).map(r => [r.tenantId, r.scope, r.role]).sort();
  const SUB_A = '00000000-0000-0000-0000-00000000000a';
  let fake: ReturnType<typeof fakeHierarchy>;

  beforeEach(async () => {
    signInAs(admin);
    fake = fakeHierarchy([
      group(TENANT, 'Tenant Root Group', null),
      group('mg-example', 'Example group', TENANT),
      subscription(SUB_A, 'Subscription A', 'mg-example'),
    ]);
    await refreshFrom(fake);
  });

  it('is accepted through the access route, stored as sent under the tenant the server resolved', async () => {
    const res = await put(target.id, { access: [{ scope: MG, role: 'editor', tenantId: 'from-the-body' }] });
    expect(res.status).toBe(200);
    expect(await rowsOf(target.id)).toEqual([[TENANT, MG, 'editor']]);
    expect(await getUser(target.id)).toMatchObject({ role: 'editor', accessSource: 'manual' });
  });

  it('is stored in the casing it was sent in, and found in the tree whatever the casing', async () => {
    const sent = MG.replace('mg-example', 'MG-Example');
    expect((await put(target.id, { access: [grant(sent, 'viewer')] })).status).toBe(200);
    expect(await rowsOf(target.id)).toEqual([[TENANT, sent, 'viewer']]);
  });

  it('reads back as the group itself in the grants, with what sits under it kept apart', async () => {
    await put(target.id, { access: [grant(MG, 'viewer')] });
    const back = await (await accessRoute.GET(getRequest(), params(target.id))).json() as AppUserWithAccess;
    expect(back.access.grants.map(g => [g.scope.kind, g.scope.path])).toEqual([['managementGroup', MG]]);
    expect(back.access.managementGroups).toEqual([expect.objectContaining({ path: MG, groups: ['mg-example'], subscriptions: [SUB_A] })]);
  });

  it('is refused with a 400 and a message that names no path when the loaded tree does not hold the group', async () => {
    const res = await put(target.id, { access: [grant('/providers/Microsoft.Management/managementGroups/mg-unknown', 'viewer')] });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: UNKNOWN_MANAGEMENT_GROUP_MESSAGE });
    expect(JSON.stringify(body)).not.toMatch(/mg-unknown|managementGroups/);
    expect(await rowsOf(target.id)).toEqual([['', '/', 'viewer']]);
  });

  it('is refused when only another tenant\'s tree holds the group', async () => {
    fake.nodes = [group(TENANT, 'Tenant Root Group', null), group('mg-example', 'Example', null, '00000000-0000-0000-0000-0000000000e1')];
    await refreshFrom(fake);
    expect((await put(target.id, { access: [grant(MG, 'viewer')] })).status).toBe(400);
  });

  it('is refused when no tree has loaded, as after a first refresh that failed', async () => {
    await resetDb();
    admin = await makeUser('admin@example.com', 'admin');
    target = await makeUser('target@example.com', 'viewer');
    signInAs(admin);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fake.failWith = new Error('boom');
    await refreshManagementGroupHierarchy({ read: fake.read });
    expect((await put(target.id, { access: [grant(MG, 'viewer')] })).status).toBe(400);
    quiet.mockRestore();
  });

  it('can be given in an invite and when demoting an Admin', async () => {
    const invited = await usersRoute.POST(jsonRequest('POST', { email: 'invited@example.com', role: 'viewer', access: [grant(MG, 'viewer')] }));
    expect(invited.status).toBe(201);
    expect(await rowsOf(((await invited.json()) as AppUserWithAccess).id)).toEqual([[TENANT, MG, 'viewer']]);

    const second = await makeUser('second@example.com', 'admin');
    const demoted = await userRoute.PUT(jsonRequest('PUT', { role: 'editor', access: [grant(MG, 'editor'), grant(SUB, 'viewer')] }), params(second.id));
    expect(demoted.status).toBe(200);
    expect(await rowsOf(second.id)).toEqual(sorted([[TENANT, MG, 'editor'], [TENANT, SUB, 'viewer']]));
  });

  it('survives an Edit that is saved without a change: the list the picker starts from holds the group', async () => {
    await put(target.id, { access: [grant(MG, 'editor'), grant(SUB, 'viewer'), grant('@directory', 'viewer')] });
    const rowsBefore = await rowsOf(target.id);
    const person = (await listUsersWithAccess()).find(u => u.id === target.id)!;
    const resaved = await put(target.id, { access: grantsOfAccess(person.access) });
    expect(resaved.status).toBe(200);
    expect(await rowsOf(target.id)).toEqual(rowsBefore);
  });

  it('stays in what the picker starts from after it leaves the tree, and the save is refused until it is removed', async () => {
    await put(target.id, { access: [grant(MG, 'viewer'), grant(SUB, 'viewer')] });
    fake.nodes = [group(TENANT, 'Tenant Root Group', null)];
    await refreshFrom(fake);

    const person = (await listUsersWithAccess()).find(u => u.id === target.id)!;
    expect(grantsOfAccess(person.access).map(g => g.scope)).toContain(MG);
    expect((await put(target.id, { access: grantsOfAccess(person.access) })).status).toBe(400);
    expect((await put(target.id, { access: [grant(SUB, 'viewer')] })).status).toBe(200);
    expect(await rowsOf(target.id)).toEqual([[TENANT, SUB, 'viewer']]);
  });

  it('writes an audit entry that holds field names only, never the group', async () => {
    await put(target.id, { access: [grant(MG, 'editor')] });
    const entries = (await listAllAuditEntries()).filter(e => e.action === 'user.access_change');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.details).toEqual({ changed: ['role', 'assignments'] });
    expect(JSON.stringify(entries[0])).not.toMatch(/mg-example|managementGroups/);
  });
});

describe('the management groups card (#273)', () => {
  const NEVER = { lastSuccessAt: null, lastAttemptAt: null, error: null };
  const nodes = [
    { id: TENANT, kind: 'managementGroup' as const, name: 'Tenant Root Group', parentId: null },
    { id: 'mg-example', kind: 'managementGroup' as const, name: 'Example group', parentId: TENANT },
    { id: '00000000-0000-0000-0000-00000000000a', kind: 'subscription' as const, name: 'Subscription A', parentId: 'mg-example' },
  ];
  const render = (initial: Parameters<typeof ManagementGroupsSection>[0]['initial']) =>
    renderToStaticMarkup(createElement(ManagementGroupsSection, { initial }));
  const LOADED = { lastSuccessAt: '2026-06-02T00:00:00.000Z', lastAttemptAt: '2026-06-02T00:00:00.000Z', error: null };
  const FAILED = {
    lastSuccessAt: '2026-06-01T00:00:00.000Z', lastAttemptAt: '2026-06-02T00:00:00.000Z',
    error: { code: 'failed' as const, message: 'The management group tree could not be read from Azure. Check the RuleBeat server logs for details.' },
  };

  it('shows the status line, Refresh, a search, and the tree with only its top level open to expand (#311)', () => {
    const html = render({ nodes, status: LOADED });
    expect(html).toContain('Management groups');
    expect(html).toContain('Last refreshed');
    expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Refresh<\/button>/);
    expect(html).toContain('aria-label="Search the management group tree"');
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-label="Expand Tenant Root Group"/);
    expect(html).not.toContain('Example group');
    expect(html).not.toContain('Subscription A');
    // A read-only tree: nothing to tick.
    expect(html).not.toMatch(/type="checkbox"/);
    expect(html).not.toContain('failed');
  });

  it('labels a management group node "Management group", not just "Group"', () => {
    const html = render({ nodes, status: LOADED });
    expect(html).toMatch(/<span class="label-grid shrink-0">Management group<\/span>/);
    expect(html).not.toMatch(/<span class="label-grid shrink-0">Group<\/span>/);
  });

  it('says the refresh failed, when, and that the tree shown is the last one that loaded', () => {
    const html = render({ nodes, status: FAILED });
    expect(html).toContain('The last refresh failed');
    expect(html).toContain('The tree shown is the last one that loaded');
    expect(html).toContain('Check the RuleBeat server logs');
    expect(html).toContain('Tenant Root Group');
  });

  it('hands an Admin the stored tree and status, and no one else', async () => {
    const fake = fakeHierarchy([group(TENANT, 'Tenant Root Group', null), group('mg-example', 'Example group', TENANT)]);
    await refreshFrom(fake, new Date('2026-06-02T00:00:00.000Z'));

    signInAs(admin);
    const view = propsWith(await AccessPage(), 'initialHierarchy').initialHierarchy as { nodes: { id: string }[]; status: unknown };
    expect(view.nodes.map(n => n.id).sort()).toEqual([TENANT, 'mg-example'].sort());
    expect(view.status).toEqual({ lastSuccessAt: '2026-06-02T00:00:00.000Z', lastAttemptAt: '2026-06-02T00:00:00.000Z', error: null });

    for (const role of ['viewer', 'editor'] as const) {
      signInAs(await makeUser(`${role}@example.com`, role));
      const page = await AccessPage();
      expect(() => propsWith(page, 'initialHierarchy')).toThrow('initialHierarchy not rendered');
    }
  });

  it('nests each group and the subscriptions under it once opened, one level deeper each, with a Collapse control', () => {
    const items = hierarchyItems(nodes);
    const html = renderToStaticMarkup(createElement(ScopeTree, {
      items, searchLabel: 'Search the management group tree', defaultExpanded: [items[0]!.key, items[0]!.children![0]!.key],
    }));
    expect(html.indexOf('Tenant Root Group')).toBeLessThan(html.indexOf('Example group'));
    expect(html.indexOf('Example group')).toBeLessThan(html.indexOf('Subscription A'));
    const indent = (name: string) => Number(new RegExp(`<li[^>]*padding-left:(\\d+)px(?:(?!</li>)[\\s\\S])*?${name}`).exec(html)?.[1]);
    expect(indent('Example group')).toBeGreaterThan(indent('Tenant Root Group'));
    expect(indent('Subscription A')).toBeGreaterThan(indent('Example group'));
    expect(html).toMatch(/aria-expanded="true"[^>]*aria-label="Collapse Tenant Root Group"/);
    // A subscription has nothing beneath it here, so it has no expand control.
    expect(html).not.toContain('Expand Subscription A');
  });

  it('says why there is no tree, never the copy of an empty one', () => {
    const never = render({ nodes: [], status: NEVER });
    expect(never).toContain('has not been loaded yet');
    expect(never).toContain('Nothing has been read yet');
    const notConnected = render({
      nodes: [],
      status: {
        lastSuccessAt: null, lastAttemptAt: '2026-06-02T00:00:00.000Z',
        error: { code: 'azure_not_configured', message: 'Azure is not connected, so the management group tree could not be read.' },
      },
    });
    expect(notConnected).toContain('no tree has loaded yet');
    expect(notConnected).toContain('Azure is not connected');
    expect(notConnected).not.toContain('Azure returned no management groups');
    const empty = render({ nodes: [], status: { lastSuccessAt: '2026-06-02T00:00:00.000Z', lastAttemptAt: '2026-06-02T00:00:00.000Z', error: null } });
    expect(empty).toContain('Azure returned no management groups');
  });
});

describe('Mirrored access on the page (#278)', () => {
  const ACCOUNT = '00000000-0000-0000-0000-0000000000c1';
  const AT = '2026-06-02T00:00:00.000Z';

  async function mirroredPerson(email: string, scopes: MirroredScope[], status?: { code: 'failed'; at: string }): Promise<AppUserWithAccess> {
    const person = await makeUser(email, 'viewer');
    await setMirroredAccess(person.id, { role: 'viewer', tenantId: TENANT, objectId: ACCOUNT, scopes, at: AT });
    if (status) await recordMirrorFailure(person.id, { objectId: ACCOUNT, code: status.code, at: status.at });
    return (await listUsersWithAccess()).find(u => u.id === person.id)!;
  }

  describe('whether the sign-in tenant is the Azure connection tenant', () => {
    beforeEach(() => {
      signInAs(admin);
      vi.stubEnv('AUTH_MICROSOFT_ENTRA_ID_ID', 'client-id-example');
      vi.stubEnv('AUTH_MICROSOFT_ENTRA_ID_SECRET', 'client-secret-example');
    });
    afterEach(() => { vi.unstubAllEnvs(); });

    const passedDown = async () => propsWith(await PersonPage(params(target.id)), 'signInTenantIsAzureTenant').signInTenantIsAzureTenant;

    it('is passed down as true when both are the same tenant, whatever the casing', async () => {
      vi.stubEnv('AUTH_MICROSOFT_ENTRA_ID_TENANT_ID', TENANT.toUpperCase());
      expect(await passedDown()).toBe(true);
    });

    it('is passed down as false when sign-in is another tenant', async () => {
      vi.stubEnv('AUTH_MICROSOFT_ENTRA_ID_TENANT_ID', '00000000-0000-0000-0000-0000000000f1');
      expect(await passedDown()).toBe(false);
    });

    it('is passed down as false when Azure is not connected', async () => {
      vi.stubEnv('AUTH_MICROSOFT_ENTRA_ID_TENANT_ID', TENANT);
      mockTenant.mockRejectedValue(new AzureNotConfiguredError('RuleBeat has no Azure credential to scan with.'));
      expect(await passedDown()).toBe(false);
    });

    it('is passed down as false when sign-in is not configured', async () => {
      vi.stubEnv('AUTH_MICROSOFT_ENTRA_ID_ID', '');
      expect(await passedDown()).toBe(false);
    });
  });

  describe('the Linked account fields', () => {
    const fields = (user: AppUserWithAccess, signInTenantIsAzureTenant: boolean) =>
      renderToStaticMarkup(createElement(LinkedAccountFields, {
        user, email: user.email, role: 'viewer', objectId: '', previewedId: null, signInTenantIsAzureTenant,
        onObjectId: () => undefined, onPreviewed: () => undefined,
      }));

    it('asks for a Linked account, and the object id field starts empty with Preview disabled', async () => {
      const person = (await listUsersWithAccess()).find(u => u.id === target.id)!;
      const html = fields(person, true);
      expect(html).toContain('Linked account');
      expect(html).toMatch(/<input[^>]*value=""/);
      expect(html).not.toContain(ACCOUNT);
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Preview<\/button>/);
    });

    it('offers "Use their sign-in account" only for a person with an oid when the sign-in tenant is the Azure tenant', async () => {
      const without = (await listUsersWithAccess()).find(u => u.id === target.id)!;
      const withOid = { ...without, oid: ACCOUNT };
      expect(fields(withOid, true)).toContain('Use their sign-in account');
      expect(fields(withOid, false)).not.toContain('Use their sign-in account');
      expect(fields(without, true)).not.toContain('Use their sign-in account');
    });

    it('never fills the field itself, even when the button is offered', async () => {
      const person = { ...(await listUsersWithAccess()).find(u => u.id === target.id)!, oid: ACCOUNT };
      const html = fields(person, true);
      expect(html).toMatch(/<input[^>]*value=""/);
      expect(html).not.toContain(`value="${ACCOUNT}"`);
    });
  });

  describe('a mirrored person', () => {
    const SCOPES: MirroredScope[] = [
      { scope: SUB, origins: [{ roleName: 'Reader', throughGroup: false, eligible: false }] },
      { scope: RG, origins: [{ roleName: 'Contributor', throughGroup: true, eligible: false }, { roleName: 'Owner', throughGroup: false, eligible: true }] },
    ];
    const detail = (user: AppUserWithAccess) => renderToStaticMarkup(createElement(MirroredDetail, { user, onChanged: () => undefined }));
    const list = (users: AppUserWithAccess[]) =>
      renderToStaticMarkup(createElement(UsersSection, { initialUsers: users, initialUsersWithPassword: [], currentUserId: admin.id }));

    it('has a Refresh button, the last successful refresh, and each Scope with its Azure role and "through a group" where recorded', async () => {
      const html = detail(await mirroredPerson('mirrored@example.com', SCOPES));
      expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Refresh<\/button>/);
      expect(html).toContain('Last refreshed');
      expect(html).toContain(ACCOUNT);
      expect(html).toContain('Reader');
      expect(html).toContain('Contributor (through a group)');
      expect(html).toContain('Owner (eligible)');
      expect(html).not.toContain('The last refresh failed');
    });

    it('says the last refresh failed, when, and that the Scopes shown are the last ones that loaded, in words of its own', async () => {
      const html = detail(await mirroredPerson('mirrored@example.com', SCOPES, { code: 'failed', at: '2026-06-03T00:00:00.000Z' }));
      expect(html).toContain('The last refresh failed');
      expect(html).toContain('The Scopes shown are the last ones that loaded');
      expect(html).toContain('Check the RuleBeat server logs');
      expect(html).toContain('Contributor (through a group)');
    });

    it('says the Linked account holds no role assignments, in place of an empty list, when it gives no Scope', async () => {
      const person = await mirroredPerson('mirrored@example.com', []);
      expect(detail(person)).toContain('holds no Azure role assignments RuleBeat can see');
      expect(list([person])).toContain('No access, mirrored');
    });

    it('is summed up in the list, with the Linked account and its Scopes left to their page', async () => {
      const html = list([await mirroredPerson('mirrored@example.com', SCOPES)]);
      expect(html).toContain('2 scopes, mirrored');
      expect(html).not.toContain(ACCOUNT);
      expect(html).not.toMatch(/Refresh<\/button>/);
    });

    it('opens on Mirrored from Azure on their page, with the Linked account and a way to link another', async () => {
      const html = personMarkup(await mirroredPerson('mirrored@example.com', SCOPES));
      expect(checkedIn(html, 'access')).toEqual(['Mirrored from Azure']);
      expect(html).toContain(ACCOUNT);
      expect(html).toMatch(/Refresh<\/button>/);
      expect(html).toContain('Link a different account');
      // The warning is for leaving Mirrored, which the page has not done yet.
      expect(html).not.toContain(EDIT_STOPS_MIRROR_NOTE);
    });

    it('shows no refresh or Linked account on the page of a person with Manual access', async () => {
      const html = personMarkup((await listUsersWithAccess()).find(u => u.id === target.id)!);
      expect(html).not.toContain('linked-account-');
      expect(html).not.toMatch(/Refresh<\/button>/);
    });
  });

  describe('a person with Manual access, in the list (#267, story 2)', () => {
    const render = (users: AppUserWithAccess[]) =>
      renderToStaticMarkup(createElement(UsersSection, { initialUsers: users, initialUsersWithPassword: [], currentUserId: admin.id }));
    const listed = async (id: string) => (await listUsersWithAccess()).filter(u => u.id === id);

    it('sums up what each person holds in one line, and links to their page for the rest', async () => {
      await setManualAccess(target.id, [
        { tenantId: TENANT, scope: SUB, role: 'viewer' },
        { tenantId: TENANT, scope: `${OTHER_SUB}/resourceGroups/rg-two`, role: 'editor' },
      ]);
      const [person] = await listed(target.id);
      const html = render([person!]);
      expect(html).toContain(describeAccess(person!.access));
      expect(html).toContain(`href="/access/users/${target.id}"`);
      expect(html).not.toContain(SUB);
      expect(html).not.toMatch(/<li/);
    });

    it('says a person given nothing has no access', async () => {
      await setManualAccess(target.id, []);
      const html = render([...await listed(target.id), ...await listed(admin.id)]);
      expect(html).toContain('No access, manual');
    });
  });

  describe('a mirrored person with no Scope, in their own access', () => {
    it('is told the Linked account holds no Azure role assignments RuleBeat can see, not that they have been given no access', async () => {
      const person = await makeUser('mirrored@example.com', 'viewer');
      await setMirroredAccess(person.id, { role: 'viewer', tenantId: TENANT, objectId: ACCOUNT, scopes: [], at: AT });
      signInAs(person);

      const own = propsWith(await AccessPage(), 'own').own as OwnAccess;
      expect(own).toMatchObject({ source: 'mirrored', scopes: [] });
      const html = renderToStaticMarkup(createElement(OwnAccessSection, { own }));
      expect(html).toContain('Linked account holds no Azure role assignments RuleBeat can see');
      expect(html).not.toContain('You have been given no access');
    });

    it('still tells a manual person with no Scope they have been given no access', async () => {
      const html = renderToStaticMarkup(createElement(OwnAccessSection, { own: { role: 'viewer', source: 'manual', scopes: [], mirror: null } }));
      expect(html).toContain('You have been given no access');
      expect(html).not.toContain('Linked account');
    });
  });

  describe('the last refresh, in their own access (#267, story 7)', () => {
    it('tells a mirrored person when their access last loaded and why the last refresh failed, without the object id', async () => {
      const person = await mirroredPerson('mirrored@example.com', [{ scope: SUB, origins: [] }], { code: 'failed', at: '2026-06-03T00:00:00.000Z' });
      signInAs((await getUser(person.id))!);

      const own = propsWith(await AccessPage(), 'own').own as OwnAccess;
      expect(own.mirror).toMatchObject({ lastSuccessAt: AT, lastAttemptAt: '2026-06-03T00:00:00.000Z', error: { code: 'failed' } });
      const html = renderToStaticMarkup(createElement(OwnAccessSection, { own }));
      expect(html).toContain('The last refresh failed');
      expect(html).toContain('The Scopes shown are the last ones that loaded');

      const body = await (await ownAccessRoute.GET()).json() as OwnAccess;
      expect(body.mirror).toEqual(own.mirror);
      expect(JSON.stringify(body)).not.toContain(ACCOUNT);
    });

    it('says when it last loaded after a refresh that worked', async () => {
      const person = await mirroredPerson('mirrored@example.com', [{ scope: SUB, origins: [] }]);
      signInAs((await getUser(person.id))!);
      const own = propsWith(await AccessPage(), 'own').own as OwnAccess;
      expect(renderToStaticMarkup(createElement(OwnAccessSection, { own }))).toContain('Last refreshed');
    });

    it('carries no refresh status for a manual person', async () => {
      signInAs(target);
      expect((propsWith(await AccessPage(), 'own').own as OwnAccess).mirror).toBeNull();
      expect(((await (await ownAccessRoute.GET()).json()) as OwnAccess).mirror).toBeNull();
    });
  });
});

describe('demoting an Admin to Mirrored access (#307)', () => {
  const LEAK = 'AuthorizationFailed: client 00000000-aaaa-bbbb-cccc-000000000000 over /subscriptions/secret-sub';
  let second: AppUser;

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    signInAs(admin);
    second = await makeUser('second@example.com', 'admin');
  });

  afterEach(() => vi.restoreAllMocks());

  const rowsOf = async (id: string) => (await listAssignmentsFor(id)).map(r => [r.tenantId, r.scope, r.role]).sort();

  /** The page's own requests, answered by the real route handlers. `between` sees the stored rows after each answer. */
  function viaRoutes(between: (url: string, rows: unknown[][]) => void = () => undefined): DemoteFetch {
    return async (url, init) => {
      const id = decodeURIComponent(url.split('/')[3]!);
      const request = new Request(`http://localhost${url}`, { method: init.method, headers: init.headers, body: init.body });
      const res = url.endsWith('/mirror') ? await mirrorRoute.PUT(request, params(id)) : await userRoute.PUT(request, params(id));
      between(url, await rowsOf(id));
      return res;
    };
  }

  it('demotes with no Scopes, then mirrors: the person ends Mirrored at the chosen Role with the account Scopes', async () => {
    const seen: [string, unknown[][]][] = [];
    const result = await demoteToMirrored({ userId: second.id, role: 'editor', objectId: ACCOUNT }, viaRoutes((url, rows) => seen.push([url, rows])));

    expect(result.ok).toBe(true);
    // Between the two steps the person held nothing: never Everything, which would fail open.
    expect(seen[0]).toEqual([`/api/users/${second.id}`, []]);
    const stored = (await getUser(second.id))!;
    expect(stored.role).toBe('editor');
    expect(stored.accessSource).toBe('mirrored');
    expect(await rowsOf(second.id)).toEqual(sorted([[TENANT, MIRROR_MG, 'editor'], [TENANT, MIRROR_SUB, 'editor']]));
    if (result.ok) {
      expect(result.user.role).toBe('editor');
      expect(result.user.accessSource).toBe('mirrored');
    }
  });

  it('leaves the person demoted with no access when the mirror step fails, and says so in plain words', async () => {
    azure.failWith = new Error(LEAK);
    const result = await demoteToMirrored({ userId: second.id, role: 'viewer', objectId: ACCOUNT }, viaRoutes());

    expect(result.ok).toBe(false);
    if (result.ok || result.stage !== 'mirror') throw new Error('expected the mirror step to fail');
    // The row the page shows is the demote answer: a Viewer who holds nothing.
    expect(result.user.role).toBe('viewer');
    expect(result.user.access.grants).toEqual([]);
    expect(result.user.access.everything).toBe(false);
    // And so is what is stored: no assignments at all, not Everything.
    expect(await rowsOf(second.id)).toEqual([]);
    expect((await getUser(second.id))!.accessSource).toBe('manual');
    const message = demotedWithoutAccessMessage(second.email, 'viewer', result.error);
    expect(message).toContain('second@example.com was demoted to Viewer and now holds no access');
    expect(message).not.toContain(LEAK);
    expect(message).not.toContain('secret-sub');
  });

  it('mirrors on a retry without demoting again, which the route would refuse for someone who is no Admin now', async () => {
    azure.failWith = new Error(LEAK);
    const failed = await demoteToMirrored({ userId: second.id, role: 'editor', objectId: ACCOUNT }, viaRoutes());
    if (failed.ok || failed.stage !== 'mirror') throw new Error('expected the mirror step to fail');

    azure.failWith = null;
    const urls: string[] = [];
    const retry = await demoteToMirrored({ userId: second.id, role: 'editor', objectId: ACCOUNT, demoted: failed.user }, async (url, init) => {
      urls.push(url);
      return viaRoutes()(url, init);
    });
    expect(urls).toEqual([`/api/users/${second.id}/mirror`]);
    expect(retry.ok).toBe(true);
    expect((await getUser(second.id))!.accessSource).toBe('mirrored');
    expect(await rowsOf(second.id)).toEqual(sorted([[TENANT, MIRROR_MG, 'editor'], [TENANT, MIRROR_SUB, 'editor']]));
  });

  it('is why the demote comes first: the mirror route refuses an Admin', async () => {
    const res = await mirrorRoute.PUT(jsonRequest('PUT', { objectId: ACCOUNT, role: 'viewer' }), params(second.id));
    expect(res.status).toBe(400);
    expect((await getUser(second.id))!.role).toBe('admin');
  });

  it('stops at a refused demote and mirrors nothing', async () => {
    // The only Admin cannot be demoted, so the demote step answers an error and no mirror is attempted.
    await userRoute.PUT(jsonRequest('PUT', { role: 'viewer', access: [grant('/', 'viewer')] }), params(second.id));
    const urls: string[] = [];
    const result = await demoteToMirrored({ userId: admin.id, role: 'viewer', objectId: ACCOUNT }, async (url, init) => {
      urls.push(url);
      return viaRoutes()(url, init);
    });
    expect(result).toMatchObject({ ok: false, stage: 'demote' });
    expect(urls).toEqual([`/api/users/${admin.id}`]);
    expect((await getUser(admin.id))!.role).toBe('admin');
  });
});

describe('saving an Edit that changed nothing (#307)', () => {
  const put = (id: string, body: unknown) => accessRoute.PUT(jsonRequest('PUT', body), params(id));
  const rowsOf = async (id: string) => (await listAssignmentsFor(id)).map(r => [r.tenantId, r.scope, r.role]).sort();

  it('sends no request, so a held management group that left the tree leaves the stored assignments as they were', async () => {
    signInAs(admin);
    const fake = fakeHierarchy([group(TENANT, 'Tenant Root Group', null), group('mg-example', 'Example group', TENANT)]);
    await refreshFrom(fake);
    expect((await put(target.id, { access: [grant(MG, 'viewer'), grant(SUB, 'editor'), grant('@directory', 'viewer')] })).status).toBe(200);
    fake.nodes = [group(TENANT, 'Tenant Root Group', null)];
    await refreshFrom(fake);
    const before = await rowsOf(target.id);

    const person = (await listUsersWithAccess()).find(u => u.id === target.id)!;
    const initial = grantsOfAccess(person.access);
    // The group is still in the list the Edit starts from, marked as not in the tree, and never dropped.
    const listed = heldRows(initial, { nodes: fake.nodes, subscriptions: [] });
    expect(listed.map(r => r.path)).toEqual(initial.map(g => g.scope));
    expect(listed.find(r => r.path === MG)).toMatchObject({ missing: true });

    const request = editSaveRequest(initial, initial, person.accessSource);
    expect(request).toBeNull();
    // Sent as it is, the route would refuse with the unknown group message: the page must not surface it.
    const refused = await put(target.id, { access: initial });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe(UNKNOWN_MANAGEMENT_GROUP_MESSAGE);
    expect(await rowsOf(target.id)).toEqual(before);
  });

  it('sends the list once something changed, and removing the missing group is what lets it save', async () => {
    signInAs(admin);
    const fake = fakeHierarchy([group(TENANT, 'Tenant Root Group', null), group('mg-example', 'Example group', TENANT)]);
    await refreshFrom(fake);
    await put(target.id, { access: [grant(MG, 'viewer'), grant(SUB, 'viewer')] });
    fake.nodes = [group(TENANT, 'Tenant Root Group', null)];
    await refreshFrom(fake);

    const person = (await listUsersWithAccess()).find(u => u.id === target.id)!;
    const initial = grantsOfAccess(person.access);
    const request = editSaveRequest(initial, initial.filter(g => g.scope !== MG), person.accessSource);
    expect(request).toEqual([grant(SUB, 'viewer')]);
    expect((await put(target.id, { access: request })).status).toBe(200);
    expect(await rowsOf(target.id)).toEqual([[TENANT, SUB, 'viewer']]);
  });
});

describe('the users table (#307, #311)', () => {
  const LONG = 'a-very-long-address-for-a-person-with-a-long-name@subdomain.example-company-name.example.com';
  const html = async () => {
    await makeUser(LONG, 'viewer');
    const users = await listUsersWithAccess();
    return renderToStaticMarkup(createElement(UsersSection, { initialUsers: users, initialUsersWithPassword: [], currentUserId: admin.id }));
  };

  it('has a search by name or email, and adds a user on a page of its own', async () => {
    const markup = await html();
    expect(markup).toContain('aria-label="Search users"');
    expect(markup).toMatch(/<a[^>]*href="\/access\/users\/new"[^>]*>(?:(?!<\/a>)[\s\S])*Add user<\/a>/);
  });

  it('cuts a long email short with the whole address on hover, and says who has never signed in', async () => {
    const markup = await html();
    expect(markup).toMatch(new RegExp(`<span[^>]*truncate[^>]*title="${LONG}"`));
    expect(markup).toContain('Never signed in');
  });

  it('fits its panel: a fixed layout, no sideways scroll box and no height cap of its own (#311)', async () => {
    const markup = await html();
    expect(markup).toMatch(/<table[^>]*class="[^"]*table-fixed/);
    expect(markup).not.toContain('data-slot="table-scroll"');
    expect(markup).not.toMatch(/max-h-/);
  });

  it('edits nothing in the row: the Role is text, each person opens their page, and the rest sits in one menu', async () => {
    const markup = await html();
    expect(markup).not.toMatch(/<select/);
    expect(markup).not.toMatch(/>Edit<\/button>/);
    expect(markup).toContain(`href="/access/users/${target.id}"`);
    expect(markup).toContain('aria-label="Actions for target@example.com"');
  });
});

describe('the Scope picker (#311)', () => {
  const render = (value: { scope: string; role: 'viewer' | 'editor' }[], role: 'viewer' | 'editor' = 'viewer') =>
    renderToStaticMarkup(createElement(ScopePicker, { value, onChange: () => undefined, role }));

  it('lists what is chosen with a remove control, and no Role of its own, while the tree loads', () => {
    const html = render([{ scope: SUB, role: 'viewer' }, { scope: '@directory', role: 'viewer' }]);
    expect(html).toContain('aria-label="Chosen Scopes"');
    expect(html).toContain('aria-label="Remove 00000000-0000-0000-0000-00000000000a"');
    expect(html).toContain('aria-label="Remove Directory"');
    expect(html).not.toContain('Different Role here');
    expect(html).not.toContain('Role at ');
    // The tree waits for the management groups and subscriptions, and says so.
    expect(html).toContain('Loading management groups');
    expect(html).toContain('Loading subscriptions');
    expect(html).not.toMatch(/type="checkbox"/);
  });

  it('says nothing is chosen yet for an empty list', () => {
    expect(render([])).toContain('Nothing is chosen yet. Tick a Scope in the tree below.');
  });

  it('says Everything covers every Scope while it is chosen', () => {
    expect(render([{ scope: '/', role: 'viewer' }])).toContain('Everything is chosen, so every Scope is already covered');
    expect(render([{ scope: SUB, role: 'viewer' }])).not.toContain('Everything is chosen');
  });
});

describe('the scope tree with ticks (#311)', () => {
  const items = hierarchyItems([
    { id: TENANT, kind: 'managementGroup', name: 'Tenant Root Group', parentId: null },
    { id: 'mg-example', kind: 'managementGroup', name: 'Example group', parentId: TENANT },
    { id: '00000000-0000-0000-0000-00000000000a', kind: 'subscription', name: 'Subscription A', parentId: 'mg-example' },
  ]);
  const render = (ticked: string[], disabled = false) => renderToStaticMarkup(createElement(ScopeTree, {
    items, searchLabel: 'Search', defaultExpanded: [items[0]!.key, items[0]!.children![0]!.key],
    selection: { isTicked: key => ticked.includes(key), onToggle: () => undefined, disabled },
  }));
  const box = (html: string, name: string) => new RegExp(`<input type="checkbox"[^>]*aria-label="${name}"[^>]*>`).exec(html)?.[0] ?? '';

  it('ticks what is held, and shows what sits beneath it as covered, ticked and not tickable again', () => {
    const html = render([MG]);
    expect(box(html, 'Example group')).toContain('checked=""');
    expect(box(html, 'Example group')).not.toContain('disabled=""');
    expect(box(html, 'Subscription A')).toContain('checked=""');
    expect(box(html, 'Subscription A')).toContain('disabled=""');
    expect(html).toContain('Covered by Example group');
    expect(box(html, 'Tenant Root Group')).not.toContain('checked=""');
  });

  it('disables every tick when the picker is disabled', () => {
    const html = render([], true);
    expect(box(html, 'Tenant Root Group')).toContain('disabled=""');
    expect(box(html, 'Subscription A')).toContain('disabled=""');
  });
});
