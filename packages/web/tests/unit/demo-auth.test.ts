/**
 * WS2g · demo mode's anonymous read-only access.
 *
 * Two things this suite exists to prove, both load-bearing:
 *
 * 1. `getCurrentUser()` only ever browses an anonymous request as the demo visitor when the full
 *    two-gate `isDemoMode()` is true — an anonymous request against a plain, non-demo install stays
 *    unauthenticated, and a demo env var with no seeded visitor row does not silently grant access
 *    to whatever `demo.db` happens to contain.
 * 2. `requireRole()`'s demo hard-deny does not rest on the visitor row's stored role staying
 *    'viewer'. It is checked ahead of, and independently from, the normal `can()` lookup — proven
 *    here by promoting the visitor row directly in the database (the way a tampered or misseeded
 *    row would look) and confirming every write action still 403s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { resetDb } from '../helpers/db';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { createUser } from '@/lib/db/users';
import { stampDemoDatabase, resetDemoModeCacheForTests, DEMO_VISITOR_ID } from '@/lib/demo';
import { deleteMeta } from '@/lib/db/meta';

const STAMP_KEY = 'demo-mode-v1';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({
  auth: () => mockAuth(),
}));

const { requireRole, getCurrentUser } = await import('@/lib/api-auth');

/** Seeds the same row `scripts/generate-demo.ts` creates — a real viewer, not a synthetic user. */
function seedDemoVisitor(): void {
  const result = createUser({ email: 'demo-visitor@rulebeat.local', role: 'viewer' });
  if ('error' in result) throw new Error(result.error);
  db.update(users).set({ id: DEMO_VISITOR_ID }).where(eq(users.id, result.user.id)).run();
}

/** Simulates a tampered or misseeded row: the id the app looks up, promoted straight in the DB. */
function tamperVisitorToAdmin(): void {
  db.update(users).set({ role: 'admin' }).where(eq(users.id, DEMO_VISITOR_ID)).run();
}

function enableDemoMode(): void {
  process.env.RULEBEAT_DEMO = '1';
  stampDemoDatabase();
  resetDemoModeCacheForTests();
}

beforeEach(async () => {
  resetDb();
  mockAuth.mockReset();
  mockAuth.mockResolvedValue(null); // anonymous by default — every test opts into a session
});

afterEach(async () => {
  delete process.env.RULEBEAT_DEMO;
  await deleteMeta(STAMP_KEY);
  resetDemoModeCacheForTests();
});

describe('getCurrentUser() and anonymous requests', () => {
  it('stays unauthenticated for an anonymous request outside demo mode', async () => {
    seedDemoVisitor();
    // isDemoMode() is false here: no enableDemoMode() call.
    expect(await getCurrentUser()).toBeNull();
  });

  it('browses as the seeded viewer row for an anonymous request in demo mode', async () => {
    seedDemoVisitor();
    enableDemoMode();

    const user = await getCurrentUser();
    expect(user?.id).toBe(DEMO_VISITOR_ID);
    expect(user?.role).toBe('viewer');
  });

  it('stays unauthenticated when demo mode is on but the visitor row was never seeded', async () => {
    // No seedDemoVisitor() — this is what an incomplete/failed generator run looks like.
    enableDemoMode();
    expect(await getCurrentUser()).toBeNull();
  });

  it('resolves a real signed-in user normally, demo mode or not', async () => {
    const result = createUser({ email: 'admin@example.com', role: 'admin' });
    if ('error' in result) throw result;
    mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
    enableDemoMode();

    const user = await getCurrentUser();
    expect(user?.id).toBe(result.user.id);
  });
});

describe('requireRole() in demo mode: read only, no matter what', () => {
  it('allows read for the anonymous demo visitor', async () => {
    seedDemoVisitor();
    enableDemoMode();

    const result = await requireRole('read');
    expect(result).not.toBeInstanceOf(NextResponse);
  });

  it('denies a write action for the anonymous demo visitor with the read-only message', async () => {
    seedDemoVisitor();
    enableDemoMode();

    const result = await requireRole('rules:write');
    expect(result).toBeInstanceOf(NextResponse);
    const res = result as NextResponse;
    expect(res.status).toBe(403);
    const body = await res.clone().json();
    expect(body.error).toMatch(/read-only demo/i);
  });

  it('denies admin-only actions for the anonymous demo visitor too', async () => {
    seedDemoVisitor();
    enableDemoMode();

    const result = await requireRole('users:manage');
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
  });

  it('still denies every write action after the visitor row is tampered to admin', async () => {
    seedDemoVisitor();
    tamperVisitorToAdmin();
    enableDemoMode();

    // Prove the tamper actually took, so a failure below is the guard, not a broken fixture.
    const visitor = await getCurrentUser();
    expect(visitor?.role).toBe('admin');

    for (const action of ['rules:write', 'users:manage', 'azure:manage', 'categories:write'] as const) {
      const result = await requireRole(action);
      expect(result, `expected '${action}' to be denied for a tampered-admin demo visitor`).toBeInstanceOf(NextResponse);
      expect((result as NextResponse).status).toBe(403);
    }
  });

  it('still allows read after the visitor row is tampered to admin', async () => {
    seedDemoVisitor();
    tamperVisitorToAdmin();
    enableDemoMode();

    const result = await requireRole('read');
    expect(result).not.toBeInstanceOf(NextResponse);
  });

  it('a real signed-in admin is unaffected by the demo hard-deny once demo mode is off', async () => {
    const result = createUser({ email: 'admin2@example.com', role: 'admin' });
    if ('error' in result) throw result;
    mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
    // Deliberately no enableDemoMode() call.

    const write = await requireRole('rules:write');
    expect(write).not.toBeInstanceOf(NextResponse);
  });
});
