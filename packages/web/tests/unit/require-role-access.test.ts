/**
 * #269: the real `requireRole` resolves Access and authorizes through `mayAct`, with only the session
 * (`@/auth`) mocked. Every action, for an Admin, an Editor and a Viewer who each hold their Role on
 * Everything, is allowed or refused exactly as `can(role, action)` says. An Editor whose only row is
 * a subscription is refused every install-wide action and can still read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { resetDb } from '../helpers/db';
import { createUser, type AppUser } from '@/lib/db/users';
import { deleteAssignmentsOn, grantAssignmentOn } from '@/lib/db/role-assignments';
import { inTransaction } from '@/lib/db/exec';
import { ACTION_CLASS, ALL_ACTIONS, can, ROLES, type Role } from '@/lib/rbac';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const { requireRole } = await import('@/lib/api-auth');

const SUB = '/subscriptions/00000000-0000-0000-0000-000000000000';

async function signedInAs(email: string, role: Role): Promise<AppUser> {
  const result = await createUser({ email, role });
  if ('error' in result) throw new Error(result.error);
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
  return result.user;
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

describe('requireRole against Everything', () => {
  for (const role of ROLES) {
    it(`allows or refuses every action for ${role === 'admin' ? 'an Admin' : `a ${role} on Everything`} exactly as can() says`, async () => {
      await signedInAs(`${role}@example.com`, role);
      for (const action of ALL_ACTIONS) {
        const result = await requireRole(action);
        if (can(role, action)) {
          expect(result, `${role} ${action}`).not.toBeInstanceOf(NextResponse);
        } else {
          expect(result, `${role} ${action}`).toBeInstanceOf(NextResponse);
          expect((result as NextResponse).status).toBe(403);
        }
      }
    });
  }
});

describe('requireRole returns the Access it resolved', () => {
  it('returns Everything for an Admin', async () => {
    await signedInAs('admin@example.com', 'admin');
    const result = await requireRole('read');
    if (result instanceof NextResponse) throw new Error('expected a user');
    expect(result.access).toMatchObject({ everything: true, source: null });
    expect(result.access.grants.map(g => g.role)).toEqual(['admin']);
  });

  it('returns the Role on Everything with the source manual for a Viewer and an Editor', async () => {
    for (const role of ['viewer', 'editor'] as const) {
      await signedInAs(`${role}@example.com`, role);
      const result = await requireRole('read');
      if (result instanceof NextResponse) throw new Error('expected a user');
      expect(result.access).toMatchObject({ everything: true, directory: false, source: 'manual' });
      expect(result.access.grants.map(g => [g.scope.kind, g.role])).toEqual([['everything', role]]);
      expect(result.email).toBe(`${role}@example.com`);
    }
  });
});

describe('an Editor whose only row is a subscription', () => {
  it('is refused every install-wide and install-administration action with 403, and still allowed read', async () => {
    const editor = await signedInAs('narrow@example.com', 'editor');
    await inTransaction(async tx => {
      await deleteAssignmentsOn(tx, editor.id);
      await grantAssignmentOn(tx, editor.id, '00000000-0000-0000-0000-000000000001', SUB, 'editor');
    });

    for (const action of ALL_ACTIONS) {
      const cls = ACTION_CLASS[action];
      const result = await requireRole(action);
      if (cls === 'install-wide' || cls === 'install-administration') {
        expect(result, action).toBeInstanceOf(NextResponse);
        expect((result as NextResponse).status, action).toBe(403);
      }
    }
    expect(await requireRole('read')).not.toBeInstanceOf(NextResponse);
    expect(await requireRole('scans:run')).not.toBeInstanceOf(NextResponse);
  });

  it('is refused every action beyond read once the row is gone', async () => {
    const editor = await signedInAs('none@example.com', 'editor');
    await inTransaction(tx => deleteAssignmentsOn(tx, editor.id));

    expect(await requireRole('read')).not.toBeInstanceOf(NextResponse);
    expect((await requireRole('scans:run') as NextResponse).status).toBe(403);
    expect((await requireRole('rules:write') as NextResponse).status).toBe(403);
  });
});
