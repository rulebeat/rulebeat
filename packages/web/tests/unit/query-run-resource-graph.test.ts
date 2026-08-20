/**
 * Spec 037 — POST /api/query/run-resource-graph, the live-query page's Resource Graph runner.
 * Mirrors validate-graph.test.ts's coverage pattern for its sibling route (rule authoring's
 * validate-graph), plus what's unique to this route: its own response-level row cap distinct from
 * Azure's truncation signal (RESPONSE_ROW_CAP = 500, not validate-graph's 5-sample cap), the
 * query.run audit trail, and the touchSavedQueryLastRun side effect when savedQueryId is passed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { fakeTenantContext } from '../helpers/fake-azure';
import type { FakeTenantContext } from '../helpers/fake-azure';
import { AzureNotConfiguredError } from '@/lib/azure-credential';
import { ResourceGraphTruncatedError } from '@rulebeat/core';
import { listAllAuditEntries } from '@/lib/db/audit';
import { createSavedQuery, getSavedQuery } from '@/lib/db/saved-queries';
import { listQueryRuns } from '@/lib/db/query-runs';
import { deleteMeta } from '@/lib/db/meta';
import { resetDemoModeCacheForTests, stampDemoDatabase } from '@/lib/demo';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

let fakeCtx: FakeTenantContext | null;
let connectError: Error | null;
vi.mock('@/lib/azure-credential', async () => {
  const actual = await vi.importActual<typeof import('@/lib/azure-credential')>('@/lib/azure-credential');
  return {
    ...actual,
    createTenantContext: () => connectError ? Promise.reject(connectError) : Promise.resolve(fakeCtx),
  };
});

const { POST } = await import('@/app/api/query/run-resource-graph/route');

function postRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/query/run-resource-graph', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function signInAs(email: string): Promise<string> {
  const result = createUser({ email, role: 'editor' });
  if ('error' in result) throw new Error(result.error);
  setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
  return result.user.id;
}

describe('POST /api/query/run-resource-graph (spec 037)', () => {
  let userId: string;

  beforeEach(async () => {
    resetDb();
    mockAuth.mockReset();
    connectError = null;
    fakeCtx = null;
    userId = await signInAs('editor@example.com');
  });

  it('rejects a request with no kql at all, before any Azure call', async () => {
    const res = await POST(postRequest({}));
    expect(res.status).toBe(400);
  });

  it('rejects blank/whitespace-only kql the same way', async () => {
    const res = await POST(postRequest({ kql: '   ' }));
    expect(res.status).toBe(400);
  });

  it('returns 503 naming the missing credential when Azure has never been configured', async () => {
    connectError = new AzureNotConfiguredError('RuleBeat has no Azure credential to scan with.');
    const res = await POST(postRequest({ kql: 'resources' }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('azure_not_configured');
  });

  it('returns a generic 500 (server logs only) when connecting fails for any other reason', async () => {
    connectError = new Error('ECONNRESET');
    const res = await POST(postRequest({ kql: 'resources' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).not.toMatch(/ECONNRESET/);
  });

  it('returns every row, uncapped, when the result is under the 500-row response cap', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ id: `r${i}`, name: `res-${i}` }));
    fakeCtx = fakeTenantContext({ rows });
    const res = await POST(postRequest({ kql: 'resources' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(7);
    expect(body.capped).toBe(false);
    expect(body.truncated).toBe(false);
    expect(body.rows).toHaveLength(7);
    expect(fakeCtx?.queries).toHaveLength(1);
  });

  it('caps the returned rows at 500 (its own display cap) when the result is larger, distinct from truncated', async () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({ id: `r${i}` }));
    fakeCtx = fakeTenantContext({ rows });
    const res = await POST(postRequest({ kql: 'resources' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(600);
    expect(body.capped).toBe(true);
    expect(body.truncated).toBe(false);
    expect(body.rows).toHaveLength(500);
  });

  it('treats a truncated ARG result as a capped success, not a failure', async () => {
    fakeCtx = fakeTenantContext({ failWith: new ResourceGraphTruncatedError(4321) });
    const res = await POST(postRequest({ kql: 'resources' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.truncated).toBe(true);
    expect(body.count).toBe(4321);
    expect(body.capped).toBe(false);
    expect(body.rows).toEqual([]);
  });

  it('unwraps a 400 (malformed KQL) to its message, at 400', async () => {
    const err = new Error('Bad request syntax near "whree"') as Error & { statusCode: number };
    err.statusCode = 400;
    fakeCtx = fakeTenantContext({ failWith: err });
    const res = await POST(postRequest({ kql: 'resources | whree' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Bad request syntax near "whree"');
  });

  it('does not unwrap a non-400 error — falls through to a generic 502', async () => {
    const err = new Error('Internal Server Error') as Error & { statusCode: number };
    err.statusCode = 500;
    fakeCtx = fakeTenantContext({ failWith: err });
    const res = await POST(postRequest({ kql: 'resources' }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).not.toMatch(/Internal Server Error/);
  });

  it('writes a query.run audit entry with a row-count summary on the good path', async () => {
    fakeCtx = fakeTenantContext({ rows: [{ id: 'r1' }, { id: 'r2' }] });
    await POST(postRequest({ kql: 'resources' }));
    const entries = listAllAuditEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('query.run');
    expect(entries[0].entityType).toBe('query');
    expect(entries[0].summary).toBe('Ran a resource-graph query (2 rows)');
    expect(entries[0].actorEmail).toBe('editor@example.com');
  });

  it('names the shown/total split in the audit summary when the response is capped', async () => {
    const rows = Array.from({ length: 512 }, (_, i) => ({ id: `r${i}` }));
    fakeCtx = fakeTenantContext({ rows });
    await POST(postRequest({ kql: 'resources' }));
    const entries = listAllAuditEntries();
    expect(entries[0].summary).toBe('Ran a resource-graph query (500 of 512 rows shown)');
  });

  it('names the truncation point in the audit summary when Azure truncated the result', async () => {
    fakeCtx = fakeTenantContext({ failWith: new ResourceGraphTruncatedError(999) });
    await POST(postRequest({ kql: 'resources' }));
    const entries = listAllAuditEntries();
    expect(entries[0].summary).toBe('Ran a resource-graph query (truncated after 999 rows)');
  });

  it("touches a saved query's lastRunAt and links the audit entry to it when savedQueryId is passed", async () => {
    const userId = await signInAs('owner@example.com');
    const saved = createSavedQuery({
      name: 'My query', queryBackend: 'resource-graph', rawKql: 'resources', visibility: 'private',
      ownerId: userId, ownerEmail: 'owner@example.com',
    });
    expect(saved.lastRunAt).toBeUndefined();

    fakeCtx = fakeTenantContext({ rows: [] });
    await POST(postRequest({ kql: 'resources', savedQueryId: saved.id }));

    expect(getSavedQuery(saved.id, userId)?.lastRunAt).toBeTruthy();
    const entries = listAllAuditEntries();
    expect(entries[0].entityId).toBe(saved.id);
  });

  describe('query run history (spec 037 follow-up — persisted, not sessionStorage)', () => {
    it('records a query_runs row on the good path', async () => {
      fakeCtx = fakeTenantContext({ rows: [{ id: 'r1' }, { id: 'r2' }] });
      await POST(postRequest({ kql: 'resources' }));
      const runs = listQueryRuns(userId);
      expect(runs).toHaveLength(1);
      expect(runs[0].queryBackend).toBe('resource-graph');
      expect(runs[0].rawKql).toBe('resources');
      expect(runs[0].count).toBe(2);
      expect(runs[0].capped).toBe(false);
      expect(runs[0].truncated).toBe(false);
    });

    it('records a truncated run as capped:false, truncated:true', async () => {
      fakeCtx = fakeTenantContext({ failWith: new ResourceGraphTruncatedError(4321) });
      await POST(postRequest({ kql: 'resources' }));
      const runs = listQueryRuns(userId);
      expect(runs).toHaveLength(1);
      expect(runs[0].truncated).toBe(true);
      expect(runs[0].count).toBe(4321);
    });

    it('links savedQueryId onto the recorded run when one was passed', async () => {
      const saved = createSavedQuery({
        name: 'My query', queryBackend: 'resource-graph', rawKql: 'resources', visibility: 'private',
        ownerId: userId, ownerEmail: 'editor@example.com',
      });
      fakeCtx = fakeTenantContext({ rows: [] });
      await POST(postRequest({ kql: 'resources', savedQueryId: saved.id }));
      expect(listQueryRuns(userId)[0].savedQueryId).toBe(saved.id);
    });

    it('does not record anything on a 400 (no kql)', async () => {
      await POST(postRequest({}));
      expect(listQueryRuns(userId)).toHaveLength(0);
    });

    it('does not record anything when the query itself fails (502)', async () => {
      const err = new Error('Internal Server Error') as Error & { statusCode: number };
      err.statusCode = 500;
      fakeCtx = fakeTenantContext({ failWith: err });
      await POST(postRequest({ kql: 'resources' }));
      expect(listQueryRuns(userId)).toHaveLength(0);
    });

    it('caps history at 20 runs per owner, newest first', async () => {
      fakeCtx = fakeTenantContext({ rows: [{ id: 'r1' }] });
      for (let i = 0; i < 23; i++) {
        await POST(postRequest({ kql: `resources | where name == "q${i}"` }));
      }
      const runs = listQueryRuns(userId);
      expect(runs).toHaveLength(20);
      expect(runs[0].rawKql).toBe('resources | where name == "q22"');
    });
  });

  describe('demo mode', () => {
    afterEach(() => {
      delete process.env.RULEBEAT_DEMO;
      deleteMeta('demo-mode-v1');
      resetDemoModeCacheForTests();
    });

    it('blocks the run with a read-only 403, never reaching Azure', async () => {
      process.env.RULEBEAT_DEMO = '1';
      stampDemoDatabase();
      resetDemoModeCacheForTests();
      fakeCtx = fakeTenantContext({ rows: [{ id: 'r1' }] });

      const res = await POST(postRequest({ kql: 'resources' }));
      expect(res.status).toBe(403);
      expect(fakeCtx?.queries).toHaveLength(0);
    });

    it('does not record run history either', async () => {
      process.env.RULEBEAT_DEMO = '1';
      stampDemoDatabase();
      resetDemoModeCacheForTests();
      fakeCtx = fakeTenantContext({ rows: [{ id: 'r1' }] });

      await POST(postRequest({ kql: 'resources' }));
      expect(listQueryRuns(userId)).toHaveLength(0);
    });
  });
});
