/**
 * The Access page and the three user routes it drives. The page has its own gate, separate from the
 * routes' guards: hiding the sidebar entry is presentation only, so a Viewer or Editor who types
 * /access gets the not-found page and every verb on /api/users answers 403.
 *
 * Driven from the page's default export and the routes' real handlers, with only the session mocked.
 */
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUser, getUser, listUsers, type AppUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
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
