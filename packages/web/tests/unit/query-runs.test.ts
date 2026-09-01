/**
 * Spec 037 follow-up — GET /api/query/runs, the live-query page's persisted run-history list.
 * Originally shipped as client-side sessionStorage; moved to a real `query_runs` table per an
 * explicit instruction to save it in the database instead. This file covers the GET route itself
 * (auth, own-runs-only scoping, ordering, shape); the POST-time recordQueryRun() call sites and
 * the 20-row prune are covered in each run-* route's own test file (query-run-resource-graph.test.ts
 * has the prune/cap assertion, since it's naturally exercised through a real run sequence there).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser, deleteUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { recordQueryRun, listQueryRuns } from '@/lib/db/query-runs';
import { deleteMeta } from '@/lib/db/meta';
import { resetDemoModeCacheForTests, stampDemoDatabase } from '@/lib/demo';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const { GET } = await import('@/app/api/query/runs/route');

async function signInAs(email: string): Promise<string> {
  const result = createUser({ email, role: 'editor' });
  if ('error' in result) throw new Error(result.error);
  setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
  return result.user.id;
}

describe('GET /api/query/runs (spec 037 follow-up)', () => {
  beforeEach(async () => {
    resetDb();
    mockAuth.mockReset();
  });

  it('returns 401 when signed out', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns an empty list for a user with no run history', async () => {
    await signInAs('editor@example.com');
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("only returns the caller's own runs, never another user's", async () => {
    const ownerId = await signInAs('owner@example.com');
    recordQueryRun({
      queryBackend: 'resource-graph', rawKql: 'resources', ownerId,
      count: 1, capped: false, truncated: false,
    });

    const otherId = await signInAs('other@example.com');
    recordQueryRun({
      queryBackend: 'resource-graph', rawKql: 'resourcecontainers', ownerId: otherId,
      count: 2, capped: false, truncated: false,
    });

    const res = await GET();
    const body: Array<{ rawKql?: string }> = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].rawKql).toBe('resourcecontainers');
  });

  it('returns runs newest-first', async () => {
    const ownerId = await signInAs('editor@example.com');
    for (let i = 0; i < 5; i++) {
      recordQueryRun({
        queryBackend: 'resource-graph', rawKql: `resources | where name == "q${i}"`, ownerId,
        count: i, capped: false, truncated: false,
      });
    }
    const res = await GET();
    const body: Array<{ rawKql?: string }> = await res.json();
    expect(body).toHaveLength(5);
    expect(body[0].rawKql).toBe('resources | where name == "q4"');
    expect(body[4].rawKql).toBe('resources | where name == "q0"');
  });

  it('round-trips every backend-specific field', async () => {
    const ownerId = await signInAs('editor@example.com');
    recordQueryRun({
      queryBackend: 'microsoft-graph',
      graphQuery: { path: 'users', filter: 'accountEnabled eq false' },
      ownerId, count: 3, capped: true, truncated: false, savedQueryId: 'some-saved-id',
    });

    const res = await GET();
    const body = await res.json();
    expect(body[0]).toMatchObject({
      queryBackend: 'microsoft-graph',
      graphQuery: { path: 'users', filter: 'accountEnabled eq false' },
      count: 3,
      capped: true,
      truncated: false,
      savedQueryId: 'some-saved-id',
    });
    expect(body[0].id).toBeTruthy();
    expect(body[0].ranAt).toBeTruthy();
  });

  describe('deleteUser() cascade', () => {
    it("removes the deleted user's query_runs rows outright — fully personal, no shared visibility to preserve", async () => {
      const ownerId = await signInAs('leaving@example.com');
      recordQueryRun({
        queryBackend: 'resource-graph', rawKql: 'resources', ownerId,
        count: 1, capped: false, truncated: false,
      });
      expect(listQueryRuns(ownerId)).toHaveLength(1);

      // Not 'admin': deleteUser() refuses to remove the last admin (see require-role-matrix.test.ts).
      const deleted = deleteUser(ownerId);
      expect(deleted).toBe(true);
      expect(listQueryRuns(ownerId)).toHaveLength(0);
    });
  });

  describe('demo mode', () => {
    afterEach(async () => {
      delete process.env.RULEBEAT_DEMO;
      await deleteMeta('demo-mode-v1');
      resetDemoModeCacheForTests();
    });

    it('blocks the read with a 403, same as every other query-page route', async () => {
      await signInAs('editor@example.com');
      process.env.RULEBEAT_DEMO = '1';
      stampDemoDatabase();
      resetDemoModeCacheForTests();

      const res = await GET();
      expect(res.status).toBe(403);
    });
  });
});
