/**
 * Codex review Phase 5, item 4: `await requireRole()` as the live integration point, not just the pure
 * `can(role, action)` predicate already covered exhaustively by rbac.test.ts.
 *
 * What's new here that the existing suites don't cover:
 *  - No session at all (api-auth.test.ts and demo-auth.test.ts both only ever mock a session).
 *  - A session whose uid points at a deleted user — spec 009's durable-revocation guarantee,
 *    unasserted anywhere: nothing proves a stale session can't still authorize after the row is gone.
 *  - Every role's allow/deny outcome flowing through await requireRole() itself, not just can() — the
 *    existing forced-password-change tests (api-auth.test.ts) only ever construct an admin fixture,
 *    so viewer/editor never actually exercised await requireRole()'s demo/password-gate wiring, only the
 *    role table.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { resetDb } from '../helpers/db';
import { createUser, deleteUser, type AppUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import type { Action, Role } from '@/lib/rbac';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({
  auth: () => mockAuth(),
}));

const { requireRole } = await import('@/lib/api-auth');

async function makeUser(email: string, role: Role): Promise<AppUser> {
  const result = await createUser({ email, role });
  if ('error' in result) throw new Error(result.error);
  return result.user;
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

describe('await requireRole() with no session', () => {
  it('401s an action every role would otherwise be granted', async () => {
    mockAuth.mockResolvedValue(null);
    const result = await requireRole('read');
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(401);
  });

  it('401s before ever reaching the role check, for an admin-only action too', async () => {
    mockAuth.mockResolvedValue(null);
    const result = await requireRole('users:manage');
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(401);
  });

  it('401s when the session object has no user at all', async () => {
    mockAuth.mockResolvedValue({});
    const result = await requireRole('read');
    expect((result as NextResponse).status).toBe(401);
  });
});

describe('await requireRole() with a session pointing at a deleted user', () => {
  it('401s rather than authorizing a stale session (spec 009 durable revocation)', async () => {
    // Not 'admin': await deleteUser() refuses to remove the last admin, which would silently defeat
    // this test's own setup rather than exercising the revocation path it's here to prove.
    const user = await makeUser('gone@example.com', 'editor');
    mockAuth.mockResolvedValue({ user: { uid: user.id } });

    // Prove the session is otherwise valid before deleting the row underneath it.
    expect(await requireRole('read')).not.toBeInstanceOf(NextResponse);

    const deleted = await deleteUser(user.id);
    expect(deleted).toBe(true);

    const result = await requireRole('read');
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(401);
  });
});

describe('await requireRole() per role, through the live guard', () => {
  const cases: Array<{ role: Role; allowed: Action; denied: Action }> = [
    { role: 'viewer', allowed: 'read', denied: 'rules:write' },
    { role: 'editor', allowed: 'rules:write', denied: 'users:manage' },
    { role: 'admin', allowed: 'users:manage', denied: 'billing:write' as Action },
  ];

  for (const { role, allowed, denied } of cases) {
    describe(role, () => {
      it(`grants ${allowed}`, async () => {
        const user = await makeUser(`${role}@example.com`, role);
        mockAuth.mockResolvedValue({ user: { uid: user.id } });
        const result = await requireRole(allowed);
        expect(result).not.toBeInstanceOf(NextResponse);
      });

      it(`403s ${denied}`, async () => {
        const user = await makeUser(`${role}-denied@example.com`, role);
        mockAuth.mockResolvedValue({ user: { uid: user.id } });
        const result = await requireRole(denied);
        expect(result).toBeInstanceOf(NextResponse);
        expect((result as NextResponse).status).toBe(403);
      });
    });
  }
});

describe('await requireRole() and forced password change, across every role', () => {
  // api-auth.test.ts's RB-QA-017 tests only ever built an admin fixture. This proves the same gate
  // applies uniformly, not just to the role that happened to be tested.
  for (const role of ['viewer', 'editor', 'admin'] as const) {
    it(`blocks a ${role}'s normal action while mustChangePassword is set`, async () => {
      const user = await makeUser(`${role}-pwd@example.com`, role);
      await setPassword(user.id, 'irrelevant-hash', { mustChangePassword: true });
      mockAuth.mockResolvedValue({ user: { uid: user.id } });

      const result = await requireRole('read');
      expect(result).toBeInstanceOf(NextResponse);
      expect((result as NextResponse).status).toBe(403);
    });

    it(`still lets a ${role} reach account:self to clear it`, async () => {
      const user = await makeUser(`${role}-pwd2@example.com`, role);
      await setPassword(user.id, 'irrelevant-hash', { mustChangePassword: true });
      mockAuth.mockResolvedValue({ user: { uid: user.id } });

      const result = await requireRole('account:self');
      expect(result).not.toBeInstanceOf(NextResponse);
    });
  }
});
