/**
 * Spec 008 — GET /api/resources/properties must distinguish "Azure is unreachable" (500/503) from
 * "this type genuinely has no schema" (404), which previously both collapsed to the same 404.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { resetDb } from '../helpers/db';
import { db } from '@/lib/db/client';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { writeSchemaCache } from '@/lib/schema-cache';
import { AzureNotConfiguredError } from '@/lib/azure-credential';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

let fail: Error | null;
let resolvedFields: string[];
vi.mock('@/lib/azure-credential', async () => {
  const actual = await vi.importActual<typeof import('@/lib/azure-credential')>('@/lib/azure-credential');
  return { ...actual, createTenantContext: () => Promise.resolve({}) };
});
vi.mock('@rulebeat/core', () => ({
  getResourceTypeFields: () => fail ? Promise.reject(fail) : Promise.resolve(resolvedFields),
}));

const { GET } = await import('@/app/api/resources/properties/route');

function clearSchemaCache() {
  db.run(sql`DELETE FROM schema_cache`);
}

function writeSchemaAt(resourceType: string, fields: string[], cachedAt: string) {
  writeSchemaCache(resourceType, fields);
  db.run(sql.raw(`UPDATE schema_cache SET cached_at = '${cachedAt}' WHERE resource_type = '${resourceType}'`));
}

function request(type: string): Request {
  return new Request(`http://localhost/api/resources/properties?type=${encodeURIComponent(type)}`);
}

async function signInAsViewer(): Promise<void> {
  const result = createUser({ email: 'viewer@example.com', role: 'viewer' });
  if ('error' in result) throw new Error(result.error);
  setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
}

describe('GET /api/resources/properties (spec 008)', () => {
  beforeEach(async () => {
    resetDb();
    clearSchemaCache();
    mockAuth.mockReset();
    fail = null;
    resolvedFields = [];
    await signInAsViewer();
  });

  it('returns a 503 naming the missing credential when nothing is configured and there is no cache', async () => {
    fail = new AzureNotConfiguredError('RuleBeat has no Azure credential to scan with.');
    const res = await GET(request('microsoft.compute/virtualmachines'));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.code).toBe('azure_not_configured');
  });

  it('returns a generic 500 (not 404) when the ARM call throws with no cache', async () => {
    fail = new Error('ECONNRESET');
    const res = await GET(request('microsoft.compute/virtualmachines'));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).not.toMatch(/^No schema found/);
  });

  it('still returns 404 when Azure genuinely has no fields for the type (no throw)', async () => {
    fail = null;
    resolvedFields = [];
    const res = await GET(request('microsoft.madeup/notreal'));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toMatch(/^No schema found/);
  });

  it('still serves the stale cache immediately when the background refresh throws', async () => {
    const staleDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    writeSchemaAt('microsoft.compute/virtualmachines', ['id', 'name'], staleDate);
    fail = new Error('ECONNRESET');

    const res = await GET(request('microsoft.compute/virtualmachines'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.source).toBe('cache-stale');
    expect(json.fields).toEqual(['id', 'name']);
  });
});
