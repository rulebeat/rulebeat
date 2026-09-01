/**
 * Spec 020 — both password-mutation routes must enforce the new policy and bump sessionEpoch so
 * every outstanding token for the affected account goes stale.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser, getUser, type AppUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { hashPassword } from '@/lib/password';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({
  auth: () => mockAuth(),
}));

const accountPasswordRoute = await import('@/app/api/account/password/route');
const usersPasswordRoute = await import('@/app/api/users/[id]/password/route');

async function makeUser(email: string, role: AppUser['role'] = 'admin'): Promise<AppUser> {
  const result = await createUser({ email, role });
  if ('error' in result) throw new Error(result.error);
  return result.user;
}

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

describe('POST /api/account/password (self-service)', () => {
  it('rejects a password shorter than the policy minimum', async () => {
    const user = await makeUser('self1@example.com');
    await setPassword(user.id, await hashPassword('irrelevant-but-long-enough'), { mustChangePassword: true });
    mockAuth.mockResolvedValue({ user: { uid: user.id } });

    const res = await accountPasswordRoute.POST(jsonRequest({ newPassword: 'short' }));
    expect(res.status).toBe(400);
    expect((await getUser(user.id))!.sessionEpoch).toBe(0);
  });

  it('rejects a blocklisted password even at full length', async () => {
    const user = await makeUser('self2@example.com');
    await setPassword(user.id, await hashPassword('irrelevant-but-long-enough'), { mustChangePassword: true });
    mockAuth.mockResolvedValue({ user: { uid: user.id } });

    const res = await accountPasswordRoute.POST(jsonRequest({ newPassword: 'password12345678' }));
    expect(res.status).toBe(400);
  });

  it('accepts a strong password, sets it, and bumps sessionEpoch', async () => {
    const user = await makeUser('self3@example.com');
    await setPassword(user.id, await hashPassword('irrelevant-but-long-enough'), { mustChangePassword: true });
    mockAuth.mockResolvedValue({ user: { uid: user.id } });

    const res = await accountPasswordRoute.POST(jsonRequest({ newPassword: 'a-genuinely-strong-pass!' }));
    expect(res.status).toBe(200);
    expect((await getUser(user.id))!.sessionEpoch).toBe(1);
  });
});

describe('PUT/DELETE /api/users/[id]/password (admin-managed)', () => {
  function params(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  it('PUT rejects an admin-supplied password shorter than the policy minimum', async () => {
    const admin = await makeUser('admin1@example.com');
    const target = await makeUser('target1@example.com', 'viewer');
    mockAuth.mockResolvedValue({ user: { uid: admin.id } });

    const res = await usersPasswordRoute.PUT(jsonRequest({ password: 'short' }), params(target.id));
    expect(res.status).toBe(400);
    expect((await getUser(target.id))!.sessionEpoch).toBe(0);
  });

  it('PUT accepts a strong admin-supplied password and bumps the target sessionEpoch', async () => {
    const admin = await makeUser('admin2@example.com');
    const target = await makeUser('target2@example.com', 'viewer');
    mockAuth.mockResolvedValue({ user: { uid: admin.id } });

    const res = await usersPasswordRoute.PUT(jsonRequest({ password: 'a-genuinely-strong-pass!' }), params(target.id));
    expect(res.status).toBe(200);
    expect((await getUser(target.id))!.sessionEpoch).toBe(1);
  });

  it('PUT with no body generates a password that clears the policy on its own', async () => {
    const admin = await makeUser('admin3@example.com');
    const target = await makeUser('target3@example.com', 'viewer');
    mockAuth.mockResolvedValue({ user: { uid: admin.id } });

    const res = await usersPasswordRoute.PUT(new Request('http://localhost/api/test', { method: 'PUT' }), params(target.id));
    expect(res.status).toBe(200);
    expect((await getUser(target.id))!.sessionEpoch).toBe(1);
  });

  it('DELETE bumps the target sessionEpoch after removing the local password', async () => {
    const admin = await makeUser('admin4@example.com');
    const target = await makeUser('target4@example.com', 'viewer');
    await setPassword(target.id, await hashPassword('whatever-long-enough'), { mustChangePassword: false });
    mockAuth.mockResolvedValue({ user: { uid: admin.id } });

    const res = await usersPasswordRoute.DELETE(new Request('http://localhost/api/test', { method: 'DELETE' }), params(target.id));
    expect(res.status).toBe(200);
    expect((await getUser(target.id))!.sessionEpoch).toBe(1);
  });
});
