import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { resetDb } from '../helpers/db';
import { createUser, type AppUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({
  auth: () => mockAuth(),
}));

const { requireRole } = await import('@/lib/api-auth');

function makeUser(email: string): AppUser {
  const result = createUser({ email, role: 'admin' });
  if ('error' in result) throw new Error(result.error);
  return result.user;
}

beforeEach(() => {
  resetDb();
  mockAuth.mockReset();
});

// RB-QA-017: the forced-password-change flag only stopped page navigation
// (app/(app)/layout.tsx), never the API — a still-temporary password kept working forever there.
describe('requireRole and a forced password change', () => {
  it('blocks a normal action while mustChangePassword is set', async () => {
    const user = makeUser('owner@example.com');
    setPassword(user.id, 'irrelevant-hash', { mustChangePassword: true });
    mockAuth.mockResolvedValue({ user: { uid: user.id } });

    const result = await requireRole('rules:write');
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
  });

  it('still allows account:self so the password can actually be changed', async () => {
    const user = makeUser('owner2@example.com');
    setPassword(user.id, 'irrelevant-hash', { mustChangePassword: true });
    mockAuth.mockResolvedValue({ user: { uid: user.id } });

    const result = await requireRole('account:self');
    expect(result).not.toBeInstanceOf(NextResponse);
  });

  it('allows normal actions again once the flag is cleared', async () => {
    const user = makeUser('owner3@example.com');
    setPassword(user.id, 'irrelevant-hash', { mustChangePassword: false });
    mockAuth.mockResolvedValue({ user: { uid: user.id } });

    const result = await requireRole('rules:write');
    expect(result).not.toBeInstanceOf(NextResponse);
  });
});
