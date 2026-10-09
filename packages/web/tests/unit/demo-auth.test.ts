/**
 * How a Demo resolves who is acting, and what it refuses.
 *
 * 1. `getCurrentUser()` resolves a request with no session as the seeded Visitor only when the full
 *    two-gate `isDemoMode()` is true. A plain install stays unauthenticated, and a Demo env var with
 *    no seeded Visitor row does not grant access to whatever `demo.db` contains.
 * 2. The Visitor is an admin and may change anything outside the Locked surfaces. The Locked
 *    surfaces (Azure connection, sign-in configuration, users) are refused by `requireRole()` with
 *    the reason, whatever role the acting row holds, and stay readable through `{ readOnly: true }`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { seedDemoVisitor } from '@/lib/demo/visitor';
import { stampDemoDatabase, resetDemoModeCacheForTests, DEMO_VISITOR_ID } from '@/lib/demo';
import { deleteMeta } from '@/lib/db/meta';

const STAMP_KEY = 'demo-mode-v2';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({
  auth: () => mockAuth(),
}));

const { requireRole, getCurrentUser } = await import('@/lib/api-auth');

async function enableDemoMode(): Promise<void> {
  process.env.RULEBEAT_DEMO = '1';
  await stampDemoDatabase();
  resetDemoModeCacheForTests();
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  mockAuth.mockResolvedValue(null); // anonymous by default — every test opts into a session
});

afterEach(async () => {
  delete process.env.RULEBEAT_DEMO;
  await deleteMeta(STAMP_KEY);
  resetDemoModeCacheForTests();
});

describe('await getCurrentUser() and anonymous requests', () => {
  it('stays unauthenticated for an anonymous request outside demo mode', async () => {
    await seedDemoVisitor();
    // await isDemoMode() is false here: no await enableDemoMode() call.
    expect(await getCurrentUser()).toBeNull();
  });

  it('acts as the seeded Visitor, an admin, for a request with no session in a Demo', async () => {
    await seedDemoVisitor();
    await enableDemoMode();

    const user = await getCurrentUser();
    expect(user?.id).toBe(DEMO_VISITOR_ID);
    expect(user?.role).toBe('admin');
  });

  it('stays unauthenticated when demo mode is on but the visitor row was never seeded', async () => {
    // No await seedDemoVisitor() — this is what an incomplete/failed generator run looks like.
    await enableDemoMode();
    expect(await getCurrentUser()).toBeNull();
  });

  it('resolves a real signed-in user normally, demo mode or not', async () => {
    const result = await createUser({ email: 'admin@example.com', role: 'admin' });
    if ('error' in result) throw result;
    mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
    await enableDemoMode();

    const user = await getCurrentUser();
    expect(user?.id).toBe(result.user.id);
  });
});

describe('requireRole() in a Demo', () => {
  it('lets the Visitor write everywhere outside the Locked surfaces', async () => {
    await seedDemoVisitor();
    await enableDemoMode();

    for (const action of [
      'read', 'rules:write', 'rules:delete', 'scans:run', 'schedules:write', 'suppressions:write',
      'dashboards:write', 'views:write', 'categories:write', 'notifications:manage', 'audit:read',
    ] as const) {
      expect(await requireRole(action), `expected '${action}' to be allowed`).not.toBeInstanceOf(NextResponse);
    }
  });

  it('refuses each Locked surface with the reason it is locked', async () => {
    await seedDemoVisitor();
    await enableDemoMode();

    const expected = {
      'azure:manage': /Azure connection is locked in the Demo/,
      'auth:manage': /Sign-in configuration is locked in the Demo/,
      'users:manage': /Users are locked in the Demo/,
      'account:self': /Users are locked in the Demo/,
    } as const;
    for (const [action, why] of Object.entries(expected)) {
      const result = await requireRole(action as keyof typeof expected);
      expect(result, `expected '${action}' to be locked`).toBeInstanceOf(NextResponse);
      const res = result as NextResponse;
      expect(res.status).toBe(403);
      expect((await res.clone().json()).error).toMatch(why);
    }
  });

  it('keeps the Locked surfaces readable for a handler that only reads', async () => {
    await seedDemoVisitor();
    await enableDemoMode();

    for (const action of ['azure:manage', 'auth:manage', 'users:manage'] as const) {
      expect(await requireRole(action, { readOnly: true })).not.toBeInstanceOf(NextResponse);
    }
  });

  it('locks the surfaces for a signed-in admin too, not only the Visitor row', async () => {
    const result = await createUser({ email: 'admin@example.com', role: 'admin' });
    if ('error' in result) throw result;
    mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
    await enableDemoMode();

    expect(await requireRole('azure:manage')).toBeInstanceOf(NextResponse);
  });

  it('leaves a real install alone: an admin manages the Azure connection outside a Demo', async () => {
    const result = await createUser({ email: 'admin2@example.com', role: 'admin' });
    if ('error' in result) throw result;
    mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
    // Deliberately no enableDemoMode() call.

    expect(await requireRole('azure:manage')).not.toBeInstanceOf(NextResponse);
    expect(await requireRole('users:manage')).not.toBeInstanceOf(NextResponse);
  });
});
