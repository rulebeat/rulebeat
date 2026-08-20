/**
 * Spec 037 — POST /api/query/run-log-analytics, the live-query page's Log Analytics runner.
 * Same coverage shape as its ARG/Graph siblings, plus the one behavior unique to this route: a
 * LogAnalyticsNotConfiguredError (no workspace set) is reported at 400 with the error's own message
 * returned verbatim — not routed through safeErrorMessage() — since "no workspace configured" is
 * itself the user-actionable detail, not something that could leak tenant internals. There is no
 * local 400-only unwrap helper on this route (unlike its ARG/Graph siblings): every other failure
 * falls straight through to the generic 502.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { fakeTenantContext } from '../helpers/fake-azure';
import type { FakeTenantContext } from '../helpers/fake-azure';
import { AzureNotConfiguredError } from '@/lib/azure-credential';
import { LogAnalyticsTruncatedError } from '@rulebeat/core';
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

const { POST } = await import('@/app/api/query/run-log-analytics/route');

function postRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/query/run-log-analytics', {
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

describe('POST /api/query/run-log-analytics (spec 037)', () => {
  let userId: string;

  beforeEach(async () => {
    resetDb();
    mockAuth.mockReset();
    connectError = null;
    fakeCtx = null;
    userId = await signInAsEditor();
  });

  it('rejects a request with no logsQuery at all, before any Azure call', async () => {
    const res = await POST(postRequest({}));
    expect(res.status).toBe(400);
  });

  it('rejects a logsQuery with blank/whitespace-only kql the same way', async () => {
    const res = await POST(postRequest({ logsQuery: { kql: '   ' } }));
    expect(res.status).toBe(400);
  });

  it('returns 503 naming the missing credential when Azure has never been configured', async () => {
    connectError = new AzureNotConfiguredError('RuleBeat has no Azure credential to scan with.');
    const res = await POST(postRequest({ logsQuery: { kql: 'Heartbeat | take 1' } }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('azure_not_configured');
  });

  it('returns a generic 500 (server logs only) when connecting fails for any other reason', async () => {
    connectError = new Error('ECONNRESET');
    const res = await POST(postRequest({ logsQuery: { kql: 'Heartbeat | take 1' } }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).not.toMatch(/ECONNRESET/);
  });

  it('returns 400 with the message verbatim when no workspace is configured', async () => {
    fakeCtx = fakeTenantContext({});
    const res = await POST(postRequest({ logsQuery: { kql: 'Heartbeat | take 1' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(
      'No Log Analytics workspace is configured. Set one in Settings or RULEBEAT_LOG_ANALYTICS_WORKSPACE_ID.',
    );
  });

  it('returns every row, uncapped, when the result is under the 500-row response cap', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ TimeGenerated: `t${i}` }));
    fakeCtx = fakeTenantContext({ logsRows: rows });
    const res = await POST(postRequest({ logsQuery: { kql: 'Heartbeat' } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(7);
    expect(body.capped).toBe(false);
    expect(body.truncated).toBe(false);
    expect(body.rows).toHaveLength(7);
    expect(fakeCtx?.logsQueries).toEqual(['Heartbeat']);
  });

  it('caps the returned rows at 500 (its own display cap) when the result is larger, distinct from truncated', async () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({ TimeGenerated: `t${i}` }));
    fakeCtx = fakeTenantContext({ logsRows: rows });
    const res = await POST(postRequest({ logsQuery: { kql: 'Heartbeat' } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(600);
    expect(body.capped).toBe(true);
    expect(body.rows).toHaveLength(500);
  });

  it('treats a truncated Logs result as a capped success, not a failure', async () => {
    fakeCtx = fakeTenantContext({ logsFailWith: new LogAnalyticsTruncatedError(300) });
    const res = await POST(postRequest({ logsQuery: { kql: 'Heartbeat' } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.truncated).toBe(true);
    expect(body.count).toBe(300);
    expect(body.capped).toBe(false);
    expect(body.rows).toEqual([]);
  });

  it('falls through any other Logs failure to a generic 502, never leaking the raw error', async () => {
    fakeCtx = fakeTenantContext({ logsFailWith: new Error('correlationId aaaa-bbbb workspace 123') });
    const res = await POST(postRequest({ logsQuery: { kql: 'Heartbeat' } }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).not.toMatch(/correlationId/);
  });

  it('writes a query.run audit entry with a row-count summary on the good path', async () => {
    fakeCtx = fakeTenantContext({ logsRows: [{ a: 1 }, { a: 2 }, { a: 3 }] });
    await POST(postRequest({ logsQuery: { kql: 'Heartbeat' } }));
    const entries = listAllAuditEntries();
    expect(entries[0].action).toBe('query.run');
    expect(entries[0].entityType).toBe('query');
    expect(entries[0].summary).toBe('Ran a log-analytics query (3 rows)');
  });

  it('names the truncation point in the audit summary when Azure truncated the result', async () => {
    fakeCtx = fakeTenantContext({ logsFailWith: new LogAnalyticsTruncatedError(77) });
    await POST(postRequest({ logsQuery: { kql: 'Heartbeat' } }));
    const entries = listAllAuditEntries();
    expect(entries[0].summary).toBe('Ran a log-analytics query (truncated after 77 rows)');
  });

  describe('query run history (spec 037 follow-up — persisted, not sessionStorage)', () => {
    it('records a query_runs row on the good path', async () => {
      fakeCtx = fakeTenantContext({ logsRows: [{ a: 1 }, { a: 2 }, { a: 3 }] });
      await POST(postRequest({ logsQuery: { kql: 'Heartbeat' } }));
      const runs = listQueryRuns(userId);
      expect(runs).toHaveLength(1);
      expect(runs[0].queryBackend).toBe('log-analytics');
      expect(runs[0].logsQuery?.kql).toBe('Heartbeat');
      expect(runs[0].count).toBe(3);
      expect(runs[0].truncated).toBe(false);
    });

    it('records a truncated run as capped:false, truncated:true', async () => {
      fakeCtx = fakeTenantContext({ logsFailWith: new LogAnalyticsTruncatedError(300) });
      await POST(postRequest({ logsQuery: { kql: 'Heartbeat' } }));
      const runs = listQueryRuns(userId);
      expect(runs).toHaveLength(1);
      expect(runs[0].truncated).toBe(true);
      expect(runs[0].count).toBe(300);
    });

    it('does not record anything when no workspace is configured (400)', async () => {
      fakeCtx = fakeTenantContext({});
      await POST(postRequest({ logsQuery: { kql: 'Heartbeat | take 1' } }));
      expect(listQueryRuns(userId)).toHaveLength(0);
    });

    it('does not record anything when the query itself fails (502)', async () => {
      fakeCtx = fakeTenantContext({ logsFailWith: new Error('correlationId aaaa-bbbb workspace 123') });
      await POST(postRequest({ logsQuery: { kql: 'Heartbeat' } }));
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
      fakeCtx = fakeTenantContext({ logsRows: [{ a: 1 }] });

      const res = await POST(postRequest({ logsQuery: { kql: 'Heartbeat' } }));
      expect(res.status).toBe(403);
      expect(fakeCtx?.logsQueries).toHaveLength(0);
    });

    it('does not record run history either', async () => {
      process.env.RULEBEAT_DEMO = '1';
      stampDemoDatabase();
      resetDemoModeCacheForTests();
      fakeCtx = fakeTenantContext({ logsRows: [{ a: 1 }] });

      await POST(postRequest({ logsQuery: { kql: 'Heartbeat' } }));
      expect(listQueryRuns(userId)).toHaveLength(0);
    });
  });
});
