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
import { UsersSection, InviteRow, PromptRows } from '@/app/(app)/access/users-section';
import { OwnAccessSection } from '@/app/(app)/access/own-access-section';
import { MirroredAccessRow } from '@/app/(app)/access/mirrored-access-form';
import type { MirroredScope } from '@/lib/access-mirror-model';
import { AzureNotConfiguredError } from '@/lib/azure-credential';
import { NO_AZURE_CONNECTION_MESSAGE, UNKNOWN_MANAGEMENT_GROUP_MESSAGE } from '@/lib/manual-access';
import { hashPassword } from '@/lib/password';
import type { Role } from '@/lib/rbac';
import { resetDb } from '../helpers/db';
import { ManagementGroupsSection } from '@/app/(app)/access/management-groups-section';
import { grantsOfAccess } from '@/lib/access-picker';
import { refreshManagementGroupHierarchy } from '@/lib/management-group-hierarchy';
import { fakeHierarchy, group, refreshFrom, subscription } from '../helpers/fake-hierarchy';

const TENANT = '00000000-0000-0000-0000-0000000000f0';
const SUB = '/subscriptions/00000000-0000-0000-0000-00000000000a';
const OTHER_SUB = '/subscriptions/00000000-0000-0000-0000-00000000000b';
const RG = `${SUB}/resourceGroups/rg-one`;
const MG = '/providers/Microsoft.Management/managementGroups/mg-example';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

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

const { default: AccessPage } = await import('@/app/(app)/access/page');
const usersRoute = await import('@/app/api/users/route');
const userRoute = await import('@/app/api/users/[id]/route');
const accessRoute = await import('@/app/api/users/[id]/access/route');
const ownAccessRoute = await import('@/app/api/access/route');
const passwordRoute = await import('@/app/api/users/[id]/password/route');

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
    expect(html.match(/Everything, manual/g)).toHaveLength(2);
    // The Access column: the Admin alone reads a bare "Everything".
    expect(html.match(/<span>Everything<\/span>/g)).toHaveLength(1);
    // The two manual people each list their one Scope below their row (#267, story 2); the Admin lists none.
    expect(html.match(/<span class="text-sm text-ink">Everything<\/span>/g)).toHaveLength(2);
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

describe('the invite form', () => {
  it('has neither source nor Scope chosen, and cannot be submitted until one is (#267, story 19)', () => {
    const html = renderToStaticMarkup(createElement('table', null, createElement('tbody', null,
      createElement(InviteRow, { onSave: () => undefined, onCancel: () => undefined }))));
    expect(html).toContain('Manual access');
    expect(html).toContain('Mirrored access');
    expect(html).toContain('Until you do, this person is given nothing');
    expect(html).not.toContain('aria-pressed="true"');
    // No Scope list and no Linked account field until a source is picked.
    expect(html).not.toContain('Choose at least one');
    expect(html).not.toContain('invite-linked-account');
    expect(html).not.toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*Add<\/button>/);
  });
});

describe('setManualAccess', () => {
  it('refuses an Admin, who is never scoped, and a person who does not exist', async () => {
    expect(await setManualAccess(admin.id, [])).toBe('admin');
    expect(await setManualAccess('00000000-0000-0000-0000-000000000099', [])).toBe('notfound');
  });
});

describe("the prompts under a person's row", () => {
  /** The prompt elements a row opens, each with the key React remounts it by. */
  function promptsOf(user: AppUserWithAccess, open: { editing?: boolean; demotingTo?: Role | null }) {
    const fragment = PromptRows({
      user, editing: open.editing ?? false, demotingTo: open.demotingTo ?? null, saving: false,
      onSaveAccess: () => undefined, onDemote: () => undefined, onCancelEdit: () => undefined, onCancelDemote: () => undefined,
    }) as ReactElement<{ children: ReactNode }>;
    const found: ReactElement<Record<string, unknown>>[] = [];
    for (const child of [fragment.props.children].flat()) if (isValidElement(child)) found.push(child as ReactElement<Record<string, unknown>>);
    return found;
  }

  it('restarts the demote prompt at the Role picked, so the button and the list never disagree', async () => {
    const second = await makeUser('second@example.com', 'admin');
    const person = (await listUsersWithAccess()).find(u => u.id === second.id)!;
    const [asViewer] = promptsOf(person, { demotingTo: 'viewer' });
    const [asEditor] = promptsOf(person, { demotingTo: 'editor' });
    expect(asViewer!.props.confirmLabel).toBe('Make Viewer');
    expect(asViewer!.props.initial).toEqual([{ scope: '/', role: 'viewer' }]);
    expect(asEditor!.props.confirmLabel).toBe('Make Editor');
    expect(asEditor!.props.initial).toEqual([{ scope: '/', role: 'editor' }]);
    // The prompt keeps its list in its own state, so only a different key makes it start again.
    expect(asEditor!.key).not.toBe(asViewer!.key);
  });

  it("restarts the Edit prompt when the person's Role or Scopes change under it", async () => {
    const before = (await listUsersWithAccess()).find(u => u.id === target.id)!;
    await inTransaction(tx => replaceAssignmentsOn(tx, target.id, [{ tenantId: TENANT, scope: SUB, role: 'editor' }]));
    const after = (await listUsersWithAccess()).find(u => u.id === target.id)!;
    const [opened] = promptsOf(before, { editing: true });
    const [reopened] = promptsOf(after, { editing: true });
    expect(opened!.key).not.toBe(reopened!.key);
    expect(promptsOf(before, { editing: true })[0]!.key).toBe(opened!.key);
  });

  it('opens nothing for a closed prompt, and no Edit prompt for an Admin', async () => {
    const person = (await listUsersWithAccess()).find(u => u.id === admin.id)!;
    expect(promptsOf(person, {})).toEqual([]);
    expect(promptsOf(person, { editing: true })).toEqual([]);
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

  it('shows the tree with each group and the subscriptions under it, when it was read, and a Refresh button', () => {
    const html = render({ nodes, status: { lastSuccessAt: '2026-06-02T00:00:00.000Z', lastAttemptAt: '2026-06-02T00:00:00.000Z', error: null } });
    expect(html).toContain('Management groups');
    expect(html.indexOf('Tenant Root Group')).toBeLessThan(html.indexOf('Example group'));
    expect(html.indexOf('Example group')).toBeLessThan(html.indexOf('Subscription A'));
    expect(html).toMatch(/Last refreshed /);
    expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Refresh<\/button>/);
    expect(html).not.toContain('failed');
  });

  it('says the refresh failed, when, and that the tree shown is the last one that loaded', () => {
    const html = render({
      nodes,
      status: {
        lastSuccessAt: '2026-06-01T00:00:00.000Z', lastAttemptAt: '2026-06-02T00:00:00.000Z',
        error: { code: 'failed', message: 'The management group tree could not be read from Azure. Check the RuleBeat server logs for details.' },
      },
    });
    expect(html).toContain('The last refresh failed');
    expect(html).toContain('The tree shown is the last one that loaded');
    expect(html).toContain('Check the RuleBeat server logs');
    expect(html).toContain('Example group');
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

  const inTable = (node: ReactElement) => renderToStaticMarkup(createElement('table', null, createElement('tbody', null, node)));

  describe('whether the sign-in tenant is the Azure connection tenant', () => {
    beforeEach(() => {
      signInAs(admin);
      vi.stubEnv('AUTH_MICROSOFT_ENTRA_ID_ID', 'client-id-example');
      vi.stubEnv('AUTH_MICROSOFT_ENTRA_ID_SECRET', 'client-secret-example');
    });
    afterEach(() => { vi.unstubAllEnvs(); });

    it('is passed down as true when both are the same tenant, whatever the casing', async () => {
      vi.stubEnv('AUTH_MICROSOFT_ENTRA_ID_TENANT_ID', TENANT.toUpperCase());
      expect(accessClientProps(await AccessPage()).signInTenantIsAzureTenant).toBe(true);
    });

    it('is passed down as false when sign-in is another tenant', async () => {
      vi.stubEnv('AUTH_MICROSOFT_ENTRA_ID_TENANT_ID', '00000000-0000-0000-0000-0000000000f1');
      expect(accessClientProps(await AccessPage()).signInTenantIsAzureTenant).toBe(false);
    });

    it('is passed down as false when Azure is not connected', async () => {
      vi.stubEnv('AUTH_MICROSOFT_ENTRA_ID_TENANT_ID', TENANT);
      mockTenant.mockRejectedValue(new AzureNotConfiguredError('RuleBeat has no Azure credential to scan with.'));
      expect(accessClientProps(await AccessPage()).signInTenantIsAzureTenant).toBe(false);
    });

    it('is passed down as false when sign-in is not configured', async () => {
      vi.stubEnv('AUTH_MICROSOFT_ENTRA_ID_ID', '');
      expect(accessClientProps(await AccessPage()).signInTenantIsAzureTenant).toBe(false);
    });
  });

  describe('the Mirrored access form', () => {
    const form = (user: AppUserWithAccess, signInTenantIsAzureTenant: boolean) =>
      inTable(createElement(MirroredAccessRow, { user, signInTenantIsAzureTenant, onSaved: () => undefined, onCancel: () => undefined }));

    it('asks for a Role and a Linked account, and the object id field starts empty with Save disabled', async () => {
      const person = (await listUsersWithAccess()).find(u => u.id === target.id)!;
      const html = form(person, true);
      expect(html).toContain('Linked account');
      expect(html).toMatch(/<input[^>]*value=""/);
      expect(html).not.toContain(ACCOUNT);
      expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*Save<\/button>/);
    });

    it('offers "Use their sign-in account" only for a person with an oid when the sign-in tenant is the Azure tenant', async () => {
      const without = (await listUsersWithAccess()).find(u => u.id === target.id)!;
      const withOid = { ...without, oid: ACCOUNT };
      expect(form(withOid, true)).toContain('Use their sign-in account');
      expect(form(withOid, false)).not.toContain('Use their sign-in account');
      expect(form(without, true)).not.toContain('Use their sign-in account');
    });

    it('never fills the field itself, even when the button is offered', async () => {
      const person = { ...(await listUsersWithAccess()).find(u => u.id === target.id)!, oid: ACCOUNT };
      const html = form(person, true);
      expect(html).toMatch(/<input[^>]*value=""/);
      expect(html).not.toContain(`value="${ACCOUNT}"`);
    });
  });

  describe('a mirrored person', () => {
    const SCOPES: MirroredScope[] = [
      { scope: SUB, origins: [{ roleName: 'Reader', throughGroup: false, eligible: false }] },
      { scope: RG, origins: [{ roleName: 'Contributor', throughGroup: true, eligible: false }, { roleName: 'Owner', throughGroup: false, eligible: true }] },
    ];
    const render = (users: AppUserWithAccess[]) =>
      renderToStaticMarkup(createElement(UsersSection, { initialUsers: users, initialUsersWithPassword: [], currentUserId: admin.id }));

    it('has a Refresh button, the last successful refresh, and each Scope with its Azure role and "through a group" where recorded', async () => {
      const html = render([await mirroredPerson('mirrored@example.com', SCOPES)]);
      expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Refresh<\/button>/);
      expect(html).toContain('Last refreshed');
      expect(html).toContain(ACCOUNT);
      expect(html).toContain('Reader');
      expect(html).toContain('Contributor (through a group)');
      expect(html).toContain('Owner (eligible)');
      expect(html).toContain('2 scopes, mirrored');
      expect(html).not.toContain('The last refresh failed');
    });

    it('says the last refresh failed, when, and that the Scopes shown are the last ones that loaded, in words of its own', async () => {
      const html = render([await mirroredPerson('mirrored@example.com', SCOPES, { code: 'failed', at: '2026-06-03T00:00:00.000Z' })]);
      expect(html).toContain('The last refresh failed');
      expect(html).toContain('The Scopes shown are the last ones that loaded');
      expect(html).toContain('Check the RuleBeat server logs');
      expect(html).toContain('Contributor (through a group)');
    });

    it('says the Linked account holds no role assignments, in place of an empty list, when it gives no Scope', async () => {
      const html = render([await mirroredPerson('mirrored@example.com', [])]);
      expect(html).toContain('holds no Azure role assignments RuleBeat can see');
      expect(html).toContain('No access, mirrored');
    });

    it('shows no refresh or Linked account for a person with Manual access', async () => {
      const html = render((await listUsersWithAccess()).filter(u => u.id === target.id));
      expect(html).not.toContain('Linked account');
      expect(html).not.toMatch(/Refresh<\/button>/);
    });

    it('says, when Edit is opened on them, that saving stops the mirror, and says nothing of the kind for a manual person', async () => {
      const mirrored = await mirroredPerson('mirrored@example.com', SCOPES);
      const manual = (await listUsersWithAccess()).find(u => u.id === target.id)!;
      const open = (user: AppUserWithAccess) => inTable(createElement(PromptRows, {
        user, editing: true, demotingTo: null, saving: false,
        onSaveAccess: () => undefined, onDemote: () => undefined, onCancelEdit: () => undefined, onCancelDemote: () => undefined,
      }));
      expect(open(mirrored)).toContain('Saving here stops the mirror');
      expect(open(manual)).not.toContain('stops the mirror');
      expect(open(mirrored)).toContain('Manual access');
      expect(open(mirrored)).toContain('Mirrored access');
    });
  });

  describe('a person with Manual access, in the list (#267, story 2)', () => {
    const render = (users: AppUserWithAccess[]) =>
      renderToStaticMarkup(createElement(UsersSection, { initialUsers: users, initialUsersWithPassword: [], currentUserId: admin.id }));
    const listed = async (id: string) => (await listUsersWithAccess()).filter(u => u.id === id);
    const scopeRows = (html: string) => [...html.matchAll(/<li[^>]*>((?:(?!<\/li>)[\s\S])*)<\/li>/g)].map(m => m[1]!.replace(/<[^>]+>/g, '|'));

    it('lists each Scope with the Role at it, without opening Edit', async () => {
      await setManualAccess(target.id, [
        { tenantId: TENANT, scope: SUB, role: 'viewer' },
        { tenantId: TENANT, scope: `${OTHER_SUB}/resourceGroups/rg-two`, role: 'editor' },
      ]);
      const rows = scopeRows(render(await listed(target.id)));
      expect(rows).toHaveLength(2);
      expect(rows.find(r => r.includes(`|${SUB}|`))).toContain('|Viewer|');
      expect(rows.find(r => r.includes(`${OTHER_SUB}/resourceGroups/rg-two`))).toContain('|Editor|');
      expect(rows.find(r => r.includes(`${OTHER_SUB}/resourceGroups/rg-two`))).toContain('rg-two in 00000000-0000-0000-0000-00000000000b');
    });

    it('has no Scope list for a person given nothing, or for an Admin', async () => {
      await setManualAccess(target.id, []);
      const html = render([...await listed(target.id), ...await listed(admin.id)]);
      expect(html).toContain('No access, manual');
      expect(scopeRows(html)).toEqual([]);
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
