/**
 * Spec 037 — POST /api/query/run-microsoft-graph, the live-query page's Microsoft Graph runner.
 * Same coverage shape as query-run-resource-graph.test.ts, plus the one thing unique to this route:
 * validateGraphQueryShape()'s 7-path resource allowlist is re-checked here (it already gates rule
 * authoring's /api/rules/validate-graph — see validate-graph.test.ts), confirming the live query page
 * cannot reach a Graph resource type that rule authoring itself would refuse.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { fakeTenantContext } from '../helpers/fake-azure';
import type { FakeTenantContext } from '../helpers/fake-azure';
import { AzureNotConfiguredError } from '@/lib/azure-credential';
import { GraphTruncatedError, type GraphQuery } from '@rulebeat/core';
import { listAllAuditEntries } from '@/lib/db/audit';
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

const { POST } = await import('@/app/api/query/run-microsoft-graph/route');

function postRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/query/run-microsoft-graph', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function signInAsEditor(): Promise<string> {
  const result = createUser({ email: 'editor@example.com', role: 'editor' });
  if ('error' in result) throw new Error(result.error);
  setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
  return result.user.id;
}

const VALID_GQ: GraphQuery = { path: 'users', filter: 'accountEnabled eq false' };

describe('POST /api/query/run-microsoft-graph (spec 037)', () => {
  let userId: string;

  beforeEach(async () => {
    resetDb();
    mockAuth.mockReset();
    connectError = null;
    fakeCtx = null;
    userId = await signInAsEditor();
  });

  it('rejects a request with no graphQuery at all, before any Azure call', async () => {
    const res = await POST(postRequest({}));
    expect(res.status).toBe(400);
  });

  it('rejects a shape-invalid graphQuery (non-allowlisted path), before any Azure call — same allowlist as rule authoring', async () => {
    const res = await POST(postRequest({ graphQuery: { path: 'directoryObjects' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not one of the Microsoft Graph resource types/);
  });

  it('returns 503 naming the missing credential when Azure has never been configured', async () => {
    connectError = new AzureNotConfiguredError('RuleBeat has no Azure credential to scan with.');
    const res = await POST(postRequest({ graphQuery: VALID_GQ }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('azure_not_configured');
  });

  it('returns a generic 500 (server logs only) when connecting fails for any other reason', async () => {
    connectError = new Error('ECONNRESET');
    const res = await POST(postRequest({ graphQuery: VALID_GQ }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).not.toMatch(/ECONNRESET/);
  });

  it('returns every row, uncapped, when the result is under the 500-row response cap', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ id: `u${i}`, displayName: `User ${i}` }));
    fakeCtx = fakeTenantContext({ graphRows: rows });
    const res = await POST(postRequest({ graphQuery: VALID_GQ }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(7);
    expect(body.capped).toBe(false);
    expect(body.truncated).toBe(false);
    expect(body.rows).toHaveLength(7);
    expect(fakeCtx?.graphRequests).toHaveLength(1);
  });

  it('caps the returned rows at 500 (its own display cap) when the result is larger, distinct from truncated', async () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({ id: `u${i}` }));
    fakeCtx = fakeTenantContext({ graphRows: rows });
    const res = await POST(postRequest({ graphQuery: VALID_GQ }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(600);
    expect(body.capped).toBe(true);
    expect(body.truncated).toBe(false);
    expect(body.rows).toHaveLength(500);
  });

  it('treats a truncated Graph result as a capped success, not a failure', async () => {
    fakeCtx = fakeTenantContext({ graphFailWith: new GraphTruncatedError(500) });
    const res = await POST(postRequest({ graphQuery: VALID_GQ }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.truncated).toBe(true);
    expect(body.count).toBe(500);
    expect(body.capped).toBe(false);
    expect(body.rows).toEqual([]);
  });

  it('unwraps a Graph API 400 (malformed filter) to its message, at 400', async () => {
    fakeCtx = fakeTenantContext({ graphFailWith: new Error("Graph API 400: Invalid filter clause 'accountEnabled eq maybe'") });
    const res = await POST(postRequest({ graphQuery: VALID_GQ }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid filter clause/);
  });

  it('does not unwrap a non-400 Graph error — falls through to a generic 502', async () => {
    fakeCtx = fakeTenantContext({ graphFailWith: new Error('Graph API 429: Too many requests') });
    const res = await POST(postRequest({ graphQuery: VALID_GQ }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).not.toMatch(/429/);
  });

  it('writes a query.run audit entry with a row-count summary on the good path', async () => {
    fakeCtx = fakeTenantContext({ graphRows: [{ id: 'u1' }] });
    await POST(postRequest({ graphQuery: VALID_GQ }));
    const entries = listAllAuditEntries();
    expect(entries[0].action).toBe('query.run');
    expect(entries[0].entityType).toBe('query');
    expect(entries[0].summary).toBe('Ran a microsoft-graph query (1 rows)');
  });

  it('names the truncation point in the audit summary when Azure truncated the result', async () => {
    fakeCtx = fakeTenantContext({ graphFailWith: new GraphTruncatedError(250) });
    await POST(postRequest({ graphQuery: VALID_GQ }));
    const entries = listAllAuditEntries();
    expect(entries[0].summary).toBe('Ran a microsoft-graph query (truncated after 250 rows)');
  });

  describe('query run history (spec 037 follow-up — persisted, not sessionStorage)', () => {
    it('records a query_runs row on the good path', async () => {
      fakeCtx = fakeTenantContext({ graphRows: [{ id: 'u1' }] });
      await POST(postRequest({ graphQuery: VALID_GQ }));
      const runs = listQueryRuns(userId);
      expect(runs).toHaveLength(1);
      expect(runs[0].queryBackend).toBe('microsoft-graph');
      expect(runs[0].graphQuery).toEqual(VALID_GQ);
      expect(runs[0].count).toBe(1);
      expect(runs[0].truncated).toBe(false);
    });

    it('records a truncated run as capped:false, truncated:true', async () => {
      fakeCtx = fakeTenantContext({ graphFailWith: new GraphTruncatedError(500) });
      await POST(postRequest({ graphQuery: VALID_GQ }));
      const runs = listQueryRuns(userId);
      expect(runs).toHaveLength(1);
      expect(runs[0].truncated).toBe(true);
      expect(runs[0].count).toBe(500);
    });

    it('does not record anything on a 400 (shape-invalid path)', async () => {
      await POST(postRequest({ graphQuery: { path: 'directoryObjects' } }));
      expect(listQueryRuns(userId)).toHaveLength(0);
    });

    it('does not record anything when the query itself fails (502)', async () => {
      fakeCtx = fakeTenantContext({ graphFailWith: new Error('Graph API 429: Too many requests') });
      await POST(postRequest({ graphQuery: VALID_GQ }));
      expect(listQueryRuns(userId)).toHaveLength(0);
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
      fakeCtx = fakeTenantContext({ graphRows: [{ id: 'u1' }] });

      const res = await POST(postRequest({ graphQuery: VALID_GQ }));
      expect(res.status).toBe(403);
      expect(fakeCtx?.graphRequests).toHaveLength(0);
    });

    it('does not record run history either', async () => {
      process.env.RULEBEAT_DEMO = '1';
      stampDemoDatabase();
      resetDemoModeCacheForTests();
      fakeCtx = fakeTenantContext({ graphRows: [{ id: 'u1' }] });

      await POST(postRequest({ graphQuery: VALID_GQ }));
      expect(listQueryRuns(userId)).toHaveLength(0);
    });
  });
});
