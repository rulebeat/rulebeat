/**
 * Spec 037 — /api/query/saved (GET/POST) and /api/query/saved/[id] (GET/DELETE), the live-query
 * page's save/list/load/delete surface. Covers the two properties the routes' own comments call out
 * as deliberate: getSavedQuery() (and therefore GET .../[id]) returns 404 identically for "doesn't
 * exist" and "exists but is a private query owned by someone else" — never 403, so existence can't be
 * probed — and visibility only ever controls *read* access: a non-owner can GET a shared query but
 * can never DELETE it, because deleteSavedQuery() re-checks strict ownership on its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { listAllAuditEntries } from '@/lib/db/audit';
import { deleteMeta } from '@/lib/db/meta';
import { resetDemoModeCacheForTests, stampDemoDatabase } from '@/lib/demo';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const { GET: listSaved, POST: createSaved } = await import('@/app/api/query/saved/route');
const { GET: getSaved, DELETE: deleteSaved } = await import('@/app/api/query/saved/[id]/route');

function postRequest(url: string, body: Record<string, unknown>): Request {
  return new Request(url, { method: 'POST', body: JSON.stringify(body) });
}

function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function signInAs(email: string): Promise<string> {
  const result = createUser({ email, role: 'editor' });
  if ('error' in result) throw new Error(result.error);
  setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
  return result.user.id;
}

function switchTo(userId: string): void {
  mockAuth.mockResolvedValue({ user: { uid: userId } });
}

const VALID_ARG_BODY = {
  name: 'My saved query', queryBackend: 'resource-graph', visibility: 'private', rawKql: 'resources',
};

let ownerId: string;

describe('/api/query/saved (spec 037)', () => {
  beforeEach(async () => {
    resetDb();
    mockAuth.mockReset();
    ownerId = await signInAs('owner@example.com');
  });

  describe('POST (create)', () => {
    it('rejects a missing name', async () => {
      const res = await createSaved(postRequest('http://localhost/api/query/saved', { ...VALID_ARG_BODY, name: '' }));
      expect(res.status).toBe(400);
    });

    it('rejects an unknown queryBackend', async () => {
      const res = await createSaved(postRequest('http://localhost/api/query/saved', { ...VALID_ARG_BODY, queryBackend: 'sql' }));
      expect(res.status).toBe(400);
    });

    it('rejects an unknown visibility', async () => {
      const res = await createSaved(postRequest('http://localhost/api/query/saved', { ...VALID_ARG_BODY, visibility: 'public' }));
      expect(res.status).toBe(400);
    });

    it('rejects a resource-graph query with neither a visual query nor raw KQL', async () => {
      const res = await createSaved(postRequest('http://localhost/api/query/saved', {
        name: 'x', queryBackend: 'resource-graph', visibility: 'private',
      }));
      expect(res.status).toBe(400);
    });

    it('rejects a microsoft-graph query with no graphQuery', async () => {
      const res = await createSaved(postRequest('http://localhost/api/query/saved', {
        name: 'x', queryBackend: 'microsoft-graph', visibility: 'private',
      }));
      expect(res.status).toBe(400);
    });

    it('rejects a log-analytics query with no logsQuery.kql', async () => {
      const res = await createSaved(postRequest('http://localhost/api/query/saved', {
        name: 'x', queryBackend: 'log-analytics', visibility: 'private', logsQuery: { kql: '  ' },
      }));
      expect(res.status).toBe(400);
    });

    it('creates the query, stamps the caller as owner, and returns it at 201', async () => {
      const res = await createSaved(postRequest('http://localhost/api/query/saved', VALID_ARG_BODY));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe('My saved query');
      expect(body.ownerEmail).toBe('owner@example.com');
      expect(body.id).toBeTruthy();
    });

    it('writes a query.save audit entry naming the backend, name, and visibility', async () => {
      await createSaved(postRequest('http://localhost/api/query/saved', VALID_ARG_BODY));
      const entries = listAllAuditEntries();
      expect(entries[0].action).toBe('query.save');
      expect(entries[0].summary).toBe('Saved a resource-graph query "My saved query" (private)');
    });

    describe('demo mode', () => {
      afterEach(() => {
        delete process.env.RULEBEAT_DEMO;
        deleteMeta('demo-mode-v1');
        resetDemoModeCacheForTests();
      });

      it('blocks creating a saved query with a read-only 403', async () => {
        process.env.RULEBEAT_DEMO = '1';
        stampDemoDatabase();
        resetDemoModeCacheForTests();
        const res = await createSaved(postRequest('http://localhost/api/query/saved', VALID_ARG_BODY));
        expect(res.status).toBe(403);
      });
    });
  });

  describe('GET (list) and visibility isolation', () => {
    it("includes the caller's own private and shared queries", async () => {
      await createSaved(postRequest('http://localhost/api/query/saved', { ...VALID_ARG_BODY, name: 'owner private', visibility: 'private' }));
      await createSaved(postRequest('http://localhost/api/query/saved', { ...VALID_ARG_BODY, name: 'owner shared', visibility: 'shared' }));

      const res = await listSaved();
      const body: Array<{ name: string }> = await res.json();
      expect(body.map(q => q.name).sort()).toEqual(['owner private', 'owner shared']);
    });

    it("includes another user's shared queries but excludes their private ones", async () => {
      await signInAs('other@example.com');
      await createSaved(postRequest('http://localhost/api/query/saved', { ...VALID_ARG_BODY, name: 'other private', visibility: 'private' }));
      await createSaved(postRequest('http://localhost/api/query/saved', { ...VALID_ARG_BODY, name: 'other shared', visibility: 'shared' }));

      switchTo(ownerId);
      const res = await listSaved();
      const body: Array<{ name: string }> = await res.json();
      const names = body.map(q => q.name);
      expect(names).toContain('other shared');
      expect(names).not.toContain('other private');
    });
  });

  describe('GET /[id] and DELETE /[id]', () => {
    it('returns 404 for an id that does not exist at all', async () => {
      const res = await getSaved(new Request('http://localhost/api/query/saved/does-not-exist'), idParams('does-not-exist'));
      expect(res.status).toBe(404);
    });

    it("returns 404 (never 403) for another user's private query, so existence can't be probed", async () => {
      const created = await createSaved(postRequest('http://localhost/api/query/saved', { ...VALID_ARG_BODY, visibility: 'private' }));
      const { id } = await created.json();

      await signInAs('other@example.com');
      const res = await getSaved(new Request(`http://localhost/api/query/saved/${id}`), idParams(id));
      expect(res.status).toBe(404);
    });

    it('lets a non-owner GET a shared query, but never DELETE it', async () => {
      const created = await createSaved(postRequest('http://localhost/api/query/saved', { ...VALID_ARG_BODY, visibility: 'shared' }));
      const { id } = await created.json();

      await signInAs('other@example.com');
      const getRes = await getSaved(new Request(`http://localhost/api/query/saved/${id}`), idParams(id));
      expect(getRes.status).toBe(200);

      const delRes = await deleteSaved(new Request(`http://localhost/api/query/saved/${id}`, { method: 'DELETE' }), idParams(id));
      expect(delRes.status).toBe(404);
    });

    it('lets the owner delete their own query and writes a query.delete audit entry', async () => {
      const created = await createSaved(postRequest('http://localhost/api/query/saved', { ...VALID_ARG_BODY, name: 'to delete', visibility: 'private' }));
      const { id } = await created.json();

      const delRes = await deleteSaved(new Request(`http://localhost/api/query/saved/${id}`, { method: 'DELETE' }), idParams(id));
      expect(delRes.status).toBe(200);

      const entries = listAllAuditEntries();
      const deleteEntry = entries.find(e => e.action === 'query.delete');
      expect(deleteEntry?.summary).toBe('Deleted a resource-graph query "to delete"');

      const getRes = await getSaved(new Request(`http://localhost/api/query/saved/${id}`), idParams(id));
      expect(getRes.status).toBe(404);
    });

    describe('demo mode', () => {
      afterEach(() => {
        delete process.env.RULEBEAT_DEMO;
        deleteMeta('demo-mode-v1');
        resetDemoModeCacheForTests();
      });

      it('blocks deleting a saved query with a read-only 403', async () => {
        const created = await createSaved(postRequest('http://localhost/api/query/saved', VALID_ARG_BODY));
        const { id } = await created.json();

        process.env.RULEBEAT_DEMO = '1';
        stampDemoDatabase();
        resetDemoModeCacheForTests();

        const res = await deleteSaved(new Request(`http://localhost/api/query/saved/${id}`, { method: 'DELETE' }), idParams(id));
        expect(res.status).toBe(403);
      });
    });
  });
});
