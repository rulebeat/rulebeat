/**
 * GET /api/diagnostics/preflight, spec'd off the docs-pass finding: a credential that fails to
 * authenticate made the whole route 500 ("Failed to run preflight checks"), because
 * `await createTenantContext()` resolves the credential and its subscription list before `await runPreflight()`
 * ever gets a context — so the per-check rendering the onboarding step is built around never
 * appeared for exactly the failure it exists to explain. The route must fold that failure into the
 * normal `PreflightResult` shape instead: the credential check fails with the curated wording, the
 * checks that never ran say why they were skipped, and the raw Azure error text stays out of the
 * response. "Nothing configured at all" is different — that stays the actionable 503 the setup
 * screen already understands.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import type { PreflightResult } from '@/lib/preflight';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

let contextOutcome: () => Promise<unknown>;
vi.mock('@/lib/azure-credential', async () => {
  const actual = await vi.importActual<typeof import('@/lib/azure-credential')>('@/lib/azure-credential');
  return { ...actual, createTenantContext: () => contextOutcome() };
});

const { GET } = await import('@/app/api/diagnostics/preflight/route');

async function signInAsAdmin(): Promise<void> {
  const result = await createUser({ email: 'admin@example.com', role: 'admin' });
  if ('error' in result) throw new Error(result.error);
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
}

describe('GET /api/diagnostics/preflight', () => {
  beforeEach(async () => {
    await resetDb();
    mockAuth.mockReset();
    await signInAsAdmin();
  });

  it('a credential that fails to authenticate yields per-check results, not a wholesale 500', async () => {
    const sensitive = '44444444-4444-4444-4444-444444444444';
    contextOutcome = () => Promise.reject(
      new Error(`AADSTS7000215: Invalid client secret provided for tenant ${sensitive}, correlation id aaaa-bbbb`),
    );

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as PreflightResult;

    expect(body.overall).toBe('fail');
    const credential = body.checks.find(c => c.id === 'credential')!;
    expect(credential.status).toBe('fail');
    expect(credential.remediation).toBeTruthy();

    // The checks that never got a context to run with still appear, saying why they did not run —
    // not silently missing, and never pretending to have run.
    for (const id of ['subscriptions', 'resource-graph', 'graph-applications'] as const) {
      const check = body.checks.find(c => c.id === id)!;
      expect(check.status).toBe('skipped');
      expect(check.summary).toMatch(/credential/i);
    }

    expect(JSON.stringify(body)).not.toContain(sensitive);
  });

  it('a network failure resolving the credential is also a per-check result, with curated wording', async () => {
    contextOutcome = () => Promise.reject(new Error('getaddrinfo ENOTFOUND login.microsoftonline.com'));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as PreflightResult;

    const credential = body.checks.find(c => c.id === 'credential')!;
    expect(credential.status).toBe('fail');
    expect(credential.summary).toMatch(/reach Azure/i);
    expect(JSON.stringify(body)).not.toContain('getaddrinfo');
  });

  it('no credential configured at all stays the actionable 503, not a fake check run', async () => {
    contextOutcome = () => Promise.reject(Object.assign(
      new Error('RuleBeat has no Azure credential to scan with.'),
      { code: 'azure_not_configured' },
    ));

    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string; code: string };
    expect(body.code).toBe('azure_not_configured');
  });
});
