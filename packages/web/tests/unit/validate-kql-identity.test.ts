/**
 * Spec 005 — POST /api/rules/validate-kql must reject a query whose sampled rows carry no usable
 * resource id, the same contract runner.ts enforces at scan time (see runner-outcomes.test.ts).
 * Without this, a rule could be saved and pass "Test query" while silently producing findings that
 * collapse onto one fingerprint at scan time (computeFingerprint hashes ruleId::resourceId).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { fakeTenantContext, argRow } from '../helpers/fake-azure';
import type { FakeTenantContext } from '../helpers/fake-azure';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

let fakeCtx: FakeTenantContext;
vi.mock('@/lib/azure-credential', () => ({
  createTenantContext: () => Promise.resolve(fakeCtx),
}));

const { POST } = await import('@/app/api/rules/validate-kql/route');

function postRequest(kql: string): Request {
  return new Request('http://localhost/api/rules/validate-kql', {
    method: 'POST',
    body: JSON.stringify({ kql }),
  });
}

async function signInAsEditor(): Promise<void> {
  const result = await createUser({ email: 'editor@example.com', role: 'editor' });
  if ('error' in result) throw new Error(result.error);
  await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
}

describe('POST /api/rules/validate-kql — identity guard (spec 005)', () => {
  beforeEach(async () => {
    await resetDb();
    mockAuth.mockReset();
    await signInAsEditor();
  });

  it('returns 400 when every sampled row has no resource id', async () => {
    fakeCtx = fakeTenantContext({ rows: [{ name: 'no-id-here' }] });

    const res = await POST(postRequest('resources | summarize count() by type'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/no resource id/);
  });

  it('returns 200 with samples when the sampled rows carry an id', async () => {
    fakeCtx = fakeTenantContext({ rows: [argRow({ name: 'vm-1' })] });

    const res = await POST(postRequest('resources | where type == "microsoft.compute/virtualmachines"'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.samples).toHaveLength(1);
  });
});

describe('POST /api/rules/validate-kql — 400 error unwrapping (spec 006)', () => {
  beforeEach(async () => {
    await resetDb();
    mockAuth.mockReset();
    await signInAsEditor();
  });

  it('still unwraps a real Azure SDK 400 error to its inner message after the shared-helper refactor', async () => {
    const azureErr = Object.assign(new Error('Please provide below info when asking for support...'), {
      statusCode: 400,
      details: [{ message: 'malformed KQL: unexpected token' }],
    });
    fakeCtx = fakeTenantContext({ failWith: azureErr });

    const res = await POST(postRequest('resources | this is not valid kql'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('malformed KQL: unexpected token');
  });

  it('does not unwrap a non-400 Azure error — the 400-only gate still holds', async () => {
    const azureErr = Object.assign(new Error('generic wrapper'), {
      statusCode: 403,
      details: [{ message: 'insufficient privileges' }],
    });
    fakeCtx = fakeTenantContext({ failWith: azureErr });

    const res = await POST(postRequest('resources | where type == "microsoft.compute/virtualmachines"'));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).not.toBe('insufficient privileges');
  });
});
