/**
 * Spec 032 — POST /api/rules/validate-graph, mirroring validate-kql-identity.test.ts's coverage of
 * its ARG sibling: good path, a malformed filter, and no-credential-configured (see
 * app/api/rules/validate-graph/route.ts). Also covers the two Graph-specific outcomes runner.ts's
 * ARG path has no equivalent for: a GraphTruncatedError counts as a real (if incomplete) result, not
 * a failure, and the 400-only unwrap gate only opens for a `Graph API 400:`-prefixed message.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { fakeTenantContext } from '../helpers/fake-azure';
import type { FakeTenantContext } from '../helpers/fake-azure';
import { AzureNotConfiguredError } from '@/lib/azure-credential';
import { GraphTruncatedError, type GraphQuery } from '@rulebeat/core';

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

const { POST } = await import('@/app/api/rules/validate-graph/route');

function postRequest(graphQuery: unknown): Request {
  return new Request('http://localhost/api/rules/validate-graph', {
    method: 'POST',
    body: JSON.stringify({ graphQuery }),
  });
}

async function signInAsEditor(): Promise<void> {
  const result = await createUser({ email: 'editor@example.com', role: 'editor' });
  if ('error' in result) throw new Error(result.error);
  await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
}

const VALID_GQ: GraphQuery = { path: 'users', filter: 'accountEnabled eq false' };

describe('POST /api/rules/validate-graph (spec 032)', () => {
  beforeEach(async () => {
    await resetDb();
    mockAuth.mockReset();
    connectError = null;
    fakeCtx = null;
    await signInAsEditor();
  });

  it('rejects a request with no graphQuery at all, before any Azure call', async () => {
    const res = await POST(postRequest(undefined));
    expect(res.status).toBe(400);
  });

  it('rejects a shape-invalid graphQuery (non-allowlisted path) before any Azure call', async () => {
    const res = await POST(postRequest({ path: 'directoryObjects' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not one of the Microsoft Graph resource types/);
  });

  it('returns 503 naming the missing credential when Azure has never been configured', async () => {
    connectError = new AzureNotConfiguredError('RuleBeat has no Azure credential to scan with.');
    const res = await POST(postRequest(VALID_GQ));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('azure_not_configured');
  });

  it('returns a generic 500 (server logs only) when connecting fails for any other reason', async () => {
    connectError = new Error('ECONNRESET');
    const res = await POST(postRequest(VALID_GQ));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).not.toMatch(/ECONNRESET/);
  });

  it('returns 200 with count/samples (capped at 5) on the good path', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ id: `u${i}`, displayName: `User ${i}` }));
    fakeCtx = fakeTenantContext({ graphRows: rows });
    const res = await POST(postRequest(VALID_GQ));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(7);
    expect(body.truncated).toBe(false);
    expect(body.samples).toHaveLength(5);
    expect(body.samples[0]).toEqual({ id: 'u0', displayName: 'User 0' });
    expect(fakeCtx?.graphRequests).toHaveLength(1);
  });

  it('treats a truncated Graph result as a capped success, not a failure', async () => {
    fakeCtx = fakeTenantContext({ graphFailWith: new GraphTruncatedError(500) });
    const res = await POST(postRequest(VALID_GQ));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.truncated).toBe(true);
    expect(body.count).toBe(500);
    expect(body.samples).toEqual([]);
  });

  it('unwraps a Graph API 400 (malformed filter) to its message, at 400', async () => {
    fakeCtx = fakeTenantContext({ graphFailWith: new Error("Graph API 400: Invalid filter clause 'accountEnabled eq maybe'") });
    const res = await POST(postRequest(VALID_GQ));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid filter clause/);
  });

  it('does not unwrap a non-400 Graph error — falls through to a generic 502', async () => {
    fakeCtx = fakeTenantContext({ graphFailWith: new Error('Graph API 429: Too many requests') });
    const res = await POST(postRequest(VALID_GQ));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).not.toMatch(/429/);
  });
});
