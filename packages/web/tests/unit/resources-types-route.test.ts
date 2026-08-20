/**
 * Spec 008 — GET /api/resources/types must distinguish "Azure is unreachable" from "genuinely no
 * types" instead of collapsing every failure into 200 { types: [] }, which made a transient Azure
 * outage indistinguishable from a real empty result on both the server and client.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { resetDb } from '../helpers/db';
import { db } from '@/lib/db/client';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { writeResourceTypesCache } from '@/lib/schema-cache';
import { AzureNotConfiguredError } from '@/lib/azure-credential';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

let fail: Error | null;
vi.mock('@/lib/azure-credential', async () => {
  const actual = await vi.importActual<typeof import('@/lib/azure-credential')>('@/lib/azure-credential');
  return { ...actual, createTenantContext: () => Promise.resolve({}) };
});
vi.mock('@rulebeat/core', () => ({
  getAllResourceTypes: () => fail ? Promise.reject(fail) : Promise.resolve(['microsoft.compute/virtualmachines']),
}));

const { GET } = await import('@/app/api/resources/types/route');

function clearTypesCache() {
  db.run(sql`DELETE FROM resource_types_cache`);
}

function writeTypesAt(types: string[], cachedAt: string) {
  writeResourceTypesCache(types);
  db.run(sql.raw(`UPDATE resource_types_cache SET cached_at = '${cachedAt}'`));
}

async function signInAsViewer(): Promise<void> {
  const result = createUser({ email: 'viewer@example.com', role: 'viewer' });
  if ('error' in result) throw new Error(result.error);
  setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
}

describe('GET /api/resources/types (spec 008)', () => {
  beforeEach(async () => {
    resetDb();
    clearTypesCache();
    mockAuth.mockReset();
    fail = null;
    await signInAsViewer();
  });

  it('returns a 503 naming the missing credential when nothing is configured and there is no cache', async () => {
    fail = new AzureNotConfiguredError('RuleBeat has no Azure credential to scan with.');
    const res = await GET();
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.code).toBe('azure_not_configured');
  });

  it('returns a generic 500 (not 200 { types: [] }) when the ARM call throws with no cache', async () => {
    fail = new Error('ECONNRESET');
    const res = await GET();
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).not.toMatch(/^\[/);
  });

  it('still serves the stale cache immediately when the background refresh throws', async () => {
    const staleDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    writeTypesAt(['microsoft.storage/storageaccounts'], staleDate);
    fail = new Error('ECONNRESET');

    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ types: ['microsoft.storage/storageaccounts'], source: 'cache-stale' });
  });
});
