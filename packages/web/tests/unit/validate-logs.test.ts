/**
 * Spec 036 — POST /api/rules/validate-logs, mirroring validate-graph.test.ts's coverage of its
 * Graph sibling (see app/api/rules/validate-graph route and its test for the pattern this follows).
 * Two error sources are distinct here and must not be conflated: await createTenantContext() throwing
 * AzureNotConfiguredError means no Azure credential at all (503, azure_not_configured) versus
 * ctx.queryLogs() throwing LogAnalyticsNotConfiguredError means a working credential but no
 * workspace ID set (400, since that's something the person validating a query can fix themselves —
 * see app/api/rules/validate-logs/route.ts's own comment on that distinction). There is no
 * Graph-style "400 unwrap" here: a bad KQL string has no purpose-built error class the way
 * truncation/not-configured do, so it falls through to the same generic 502 safeErrorMessage() path
 * every other unclassified Azure failure uses (spec 036 risk #1, documented in the route itself).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { fakeTenantContext } from '../helpers/fake-azure';
import type { FakeTenantContext } from '../helpers/fake-azure';
import { AzureNotConfiguredError } from '@/lib/azure-credential';
import { LogAnalyticsTruncatedError, type LogAnalyticsQuery } from '@rulebeat/core';

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

const { POST } = await import('@/app/api/rules/validate-logs/route');

function postRequest(logsQuery: unknown): Request {
  return new Request('http://localhost/api/rules/validate-logs', {
    method: 'POST',
    body: JSON.stringify({ logsQuery }),
  });
}

async function signInAsEditor(): Promise<void> {
  const result = await createUser({ email: 'editor@example.com', role: 'editor' });
  if ('error' in result) throw new Error(result.error);
  await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
}

const VALID_LQ: LogAnalyticsQuery = { kql: 'SigninLogs | where ResultType != 0', timeWindowDays: 30 };

describe('POST /api/rules/validate-logs (spec 036)', () => {
  beforeEach(async () => {
    await resetDb();
    mockAuth.mockReset();
    connectError = null;
    fakeCtx = null;
    await signInAsEditor();
  });

  it('rejects a request with no logsQuery at all, before any Azure call', async () => {
    const res = await POST(postRequest(undefined));
    expect(res.status).toBe(400);
  });

  it('rejects a shape-invalid logsQuery (blank kql) before any Azure call', async () => {
    const res = await POST(postRequest({ kql: '   ', timeWindowDays: 30 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/KQL query/);
  });

  it('returns 503 naming the missing credential when Azure has never been configured', async () => {
    connectError = new AzureNotConfiguredError('RuleBeat has no Azure credential to scan with.');
    const res = await POST(postRequest(VALID_LQ));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('azure_not_configured');
  });

  it('returns a generic 500 (server logs only) when connecting fails for any other reason', async () => {
    connectError = new Error('ECONNRESET');
    const res = await POST(postRequest(VALID_LQ));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).not.toMatch(/ECONNRESET/);
  });

  it('returns 400 naming the missing workspace when connected but no workspace is configured', async () => {
    // Distinct from the AzureNotConfiguredError case above: the credential itself works
    // (createTenantContext succeeds), but ctx.queryLogs() has no workspace ID to query against.
    fakeCtx = fakeTenantContext({}); // logsRows unset -> LogAnalyticsNotConfiguredError
    const res = await POST(postRequest(VALID_LQ));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/workspace/);
  });

  it('returns 200 with count/samples (capped at 5) on the good path', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ UserId: `u${i}` }));
    fakeCtx = fakeTenantContext({ logsRows: rows });
    const res = await POST(postRequest(VALID_LQ));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(7);
    expect(body.truncated).toBe(false);
    expect(body.samples).toHaveLength(5);
    expect(body.samples[0]).toEqual({ UserId: 'u0' });
    expect(fakeCtx?.logsQueries).toHaveLength(1);
  });

  it('treats a truncated Log Analytics result as a capped success, not a failure', async () => {
    fakeCtx = fakeTenantContext({ logsFailWith: new LogAnalyticsTruncatedError(500) });
    const res = await POST(postRequest(VALID_LQ));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.truncated).toBe(true);
    expect(body.count).toBe(500);
    expect(body.samples).toEqual([]);
  });

  it('falls through an unclassified query failure (e.g. bad KQL syntax) to a generic 502, message not leaked', async () => {
    fakeCtx = fakeTenantContext({ logsFailWith: new Error("Bad request: 'SigninLog' is not a recognized table name") });
    const res = await POST(postRequest(VALID_LQ));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).not.toMatch(/SigninLog/);
  });
});
