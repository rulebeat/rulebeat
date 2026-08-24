/**
 * The "reuse the Azure connection's app registration" path on PUT /api/settings/sign-in
 * (`reuseAzureConnection: true`). The server copies the already-encrypted Azure connection
 * credential straight into the SSO provider row — the client secret never travels to the browser
 * for this path, unlike manual entry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser, type AppUser } from '@/lib/db/users';
import { listAzureCredentials, deleteAzureCredential, saveAzureCredential } from '@/lib/db/azure-credentials';
import { resolveSignInConfig } from '@/lib/sign-in-config';
import { listAuditEntries } from '@/lib/db/audit';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const signInRoute = await import('@/app/api/settings/sign-in/route');

const TENANT = '33333333-3333-3333-3333-333333333333';
const CLIENT = '44444444-4444-4444-4444-444444444444';
const AZURE_SECRET = 'the-azure-connection-secret';

function makeAdmin(email: string): AppUser {
  const result = createUser({ email, role: 'admin' });
  if ('error' in result) throw new Error(result.error);
  return result.user;
}

function putRequest(body: unknown): Request {
  return new Request('http://localhost/api/settings/sign-in', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function okDiscoveryDoc(): Response {
  return new Response('{}', { status: 200 });
}

beforeEach(() => {
  resetDb();
  for (const c of listAzureCredentials()) deleteAzureCredential(c.id);
  mockAuth.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PUT /api/settings/sign-in with reuseAzureConnection', () => {
  it('copies the stored Azure connection credential into the SSO provider, without the secret ever reaching the browser', async () => {
    saveAzureCredential({ tenantId: TENANT, clientId: CLIENT, clientSecret: AZURE_SECRET });
    const admin = makeAdmin('reuse-ok@example.com');
    mockAuth.mockResolvedValue({ user: { uid: admin.id } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okDiscoveryDoc()));

    const res = await signInRoute.PUT(putRequest({ reuseAzureConnection: true }));
    const body = await res.json() as { stored?: { tenantId: string; clientId: string } };

    expect(res.status).toBe(200);
    expect(body.stored?.tenantId).toBe(TENANT);
    expect(body.stored?.clientId).toBe(CLIENT);
    expect(JSON.stringify(body)).not.toContain(AZURE_SECRET);

    const resolved = resolveSignInConfig();
    expect(resolved?.source).toBe('stored');
    expect(resolved?.clientSecret).toBe(AZURE_SECRET);
  });

  it('refuses with 409 when there is no Azure connection to reuse', async () => {
    const admin = makeAdmin('reuse-none@example.com');
    mockAuth.mockResolvedValue({ user: { uid: admin.id } });

    const res = await signInRoute.PUT(putRequest({ reuseAzureConnection: true }));
    const body = await res.json() as { error?: string };

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/connect azure first/i);
  });

  it('still refuses when sign-in is managed by environment variables, even with an Azure connection present', async () => {
    saveAzureCredential({ tenantId: TENANT, clientId: CLIENT, clientSecret: AZURE_SECRET });
    const admin = makeAdmin('reuse-env@example.com');
    mockAuth.mockResolvedValue({ user: { uid: admin.id } });

    process.env.AUTH_MICROSOFT_ENTRA_ID_ID = 'env-client-id';
    process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET = 'env-client-secret';
    process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID = '11111111-1111-1111-1111-111111111111';
    try {
      const res = await signInRoute.PUT(putRequest({ reuseAzureConnection: true }));
      expect(res.status).toBe(409);
      expect(resolveSignInConfig()?.source).toBe('env');
    } finally {
      delete process.env.AUTH_MICROSOFT_ENTRA_ID_ID;
      delete process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET;
      delete process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID;
    }
  });

  it('records in the audit log that sign-in was configured by reusing the Azure connection', async () => {
    saveAzureCredential({ tenantId: TENANT, clientId: CLIENT, clientSecret: AZURE_SECRET });
    const admin = makeAdmin('reuse-audit@example.com');
    mockAuth.mockResolvedValue({ user: { uid: admin.id } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okDiscoveryDoc()));

    await signInRoute.PUT(putRequest({ reuseAzureConnection: true }));

    const entries = listAuditEntries();
    const entry = entries.find(e => e.action === 'sign_in_config.save');
    expect(entry?.summary).toContain('reusing the Azure connection app registration');
  });
});
