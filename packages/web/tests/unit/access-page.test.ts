/**
 * The Access page and the three user routes it drives. The page has its own gate, separate from the
 * routes' guards: hiding the sidebar entry is presentation only, so a Viewer or Editor who types
 * /access gets the not-found page and every verb on /api/users answers 403.
 *
 * Driven from the page's default export and the routes' real handlers, with only the session mocked.
 */
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUser, getUser, listUsers, type AppUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { listAllAuditEntries } from '@/lib/db/audit';
import { deleteAssignmentsOn, listAssignmentsFor } from '@/lib/db/role-assignments';
import { inTransaction } from '@/lib/db/exec';
import { listUsersWithAccess, type AppUserWithAccess } from '@/lib/access';
import { describeAccess } from '@/lib/access-model';
import { UsersSection } from '@/app/(app)/access/users-section';
import { hashPassword } from '@/lib/password';
import type { Role } from '@/lib/rbac';
import { resetDb } from '../helpers/db';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
const { default: AccessPage } = await import('@/app/(app)/access/page');
const usersRoute = await import('@/app/api/users/route');
const userRoute = await import('@/app/api/users/[id]/route');
const passwordRoute = await import('@/app/api/users/[id]/password/route');

async function makeUser(email: string, role: Role): Promise<AppUser> {
  const result = await createUser({ email, role });
  if ('error' in result) throw new Error(result.error);
  return result.user;
}

function signInAs(user: AppUser) {
  mockAuth.mockResolvedValue({ user: { uid: user.id } });
}

function accessClientProps(node: ReactNode): Record<string, unknown> {
  const queue: ReactNode[] = [node];
  while (queue.length > 0) {
    const next = queue.shift();
    if (Array.isArray(next)) { queue.push(...next); continue; }
    if (!isValidElement(next)) continue;
    const props = (next as ReactElement<Record<string, unknown>>).props;
    if ('initialUsers' in props) return props;
    queue.push(props.children as ReactNode);
  }
  throw new Error('AccessClient not rendered');
}

function jsonRequest(method: string, body: unknown): Request {
  return new Request('http://localhost/api/test', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

let admin: AppUser;
let target: AppUser;

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  admin = await makeUser('admin@example.com', 'admin');
  target = await makeUser('target@example.com', 'viewer');
});

describe('the Access page', () => {
  it.each(['viewer', 'editor'] as const)('is not found for a %s', async (role) => {
    signInAs(await makeUser(`${role}@example.com`, role));
    await expect(AccessPage()).rejects.toMatchObject({ digest: expect.stringContaining('404') });
  });

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
});

describe.each(['viewer', 'editor'] as const)('the user routes for a %s', (role) => {
  beforeEach(async () => {
    signInAs(await makeUser(`${role}@example.com`, role));
  });

  it('refuses GET and POST /api/users', async () => {
    expect((await usersRoute.GET()).status).toBe(403);
    expect((await usersRoute.POST(jsonRequest('POST', { email: 'new@example.com', role: 'viewer' }))).status).toBe(403);
    expect((await listUsers()).map(u => u.email)).not.toContain('new@example.com');
  });

  it('refuses PUT and DELETE /api/users/[id]', async () => {
    expect((await userRoute.PUT(jsonRequest('PUT', { role: 'admin' }), params(target.id))).status).toBe(403);
    expect((await userRoute.DELETE(jsonRequest('DELETE', {}), params(target.id))).status).toBe(403);
    expect((await getUser(target.id))!.role).toBe('viewer');
  });

  it('refuses PUT and DELETE /api/users/[id]/password', async () => {
    expect((await passwordRoute.PUT(jsonRequest('PUT', { password: 'a-genuinely-strong-pass!' }), params(target.id))).status).toBe(403);
    expect((await passwordRoute.DELETE(jsonRequest('DELETE', {}), params(target.id))).status).toBe(403);
    expect((await getUser(target.id))!.sessionEpoch).toBe(0);
  });
});

describe('the user routes for an admin', () => {
  beforeEach(() => signInAs(admin));

  it('invites a user by email with a role', async () => {
    const res = await usersRoute.POST(jsonRequest('POST', { email: 'invited@example.com', role: 'editor' }));
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
    const res = await userRoute.PUT(jsonRequest('PUT', { role: 'viewer' }), params(admin.id));
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
    expect(html.match(/>Everything</g)).toHaveLength(1);
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

  it('shows an invite and a Role change without a reload: the responses carry the access', async () => {
    const invited = await (await usersRoute.POST(jsonRequest('POST', { email: 'invited@example.com', role: 'editor' }))).json() as AppUserWithAccess;
    expect(describeAccess(invited.access)).toBe('Everything, manual');
    expect(invited.access.grants.map(g => g.role)).toEqual(['editor']);

    const promoted = await (await userRoute.PUT(jsonRequest('PUT', { role: 'admin' }), params(target.id))).json() as AppUserWithAccess;
    expect(describeAccess(promoted.access)).toBe('Everything');

    const demoted = await (await userRoute.PUT(jsonRequest('PUT', { role: 'viewer' }), params(target.id))).json() as AppUserWithAccess;
    expect(describeAccess(demoted.access)).toBe('Everything, manual');
    expect(demoted.access.grants.map(g => g.role)).toEqual(['viewer']);
  });

  it('inviting a Viewer or Editor creates their Everything row, and an Admin gets none', async () => {
    for (const role of ['viewer', 'editor', 'admin'] as const) {
      const res = await usersRoute.POST(jsonRequest('POST', { email: `${role}-new@example.com`, role }));
      const created = await res.json() as AppUserWithAccess;
      const rows = await listAssignmentsFor(created.id);
      expect(rows, role).toEqual(role === 'admin' ? [] : [{ userId: created.id, tenantId: '', scope: '/', role }]);
    }
  });

  it('promoting to Admin removes the rows', async () => {
    await userRoute.PUT(jsonRequest('PUT', { role: 'admin' }), params(target.id));
    expect(await listAssignmentsFor(target.id)).toEqual([]);
    expect((await getUser(target.id))!.accessSource).toBeNull();
  });

  it('demoting an Admin creates the Everything row at the new Role', async () => {
    const second = await makeUser('second@example.com', 'admin');
    await userRoute.PUT(jsonRequest('PUT', { role: 'editor' }), params(second.id));
    expect(await listAssignmentsFor(second.id)).toEqual([{ userId: second.id, tenantId: '', scope: '/', role: 'editor' }]);
    expect((await getUser(second.id))!.accessSource).toBe('manual');
  });

  it('removing a person removes their rows', async () => {
    await userRoute.DELETE(jsonRequest('DELETE', {}), params(target.id));
    expect(await listAssignmentsFor(target.id)).toEqual([]);
  });

  it('writes field names only into the invite and Role change audit entries', async () => {
    await usersRoute.POST(jsonRequest('POST', { email: 'invited@example.com', role: 'editor' }));
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
});
