/**
 * POST /api/schemas filed both "Azure genuinely returned no fields for this type" and "the ARM call
 * for this type threw" under the same `status: 'error'` label. Applies the established distinction
 * (thrown error vs. genuine empty result) to this route's per-type result array.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, execRaw } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

vi.mock('@/lib/azure-credential', async () => {
  const actual = await vi.importActual<typeof import('@/lib/azure-credential')>('@/lib/azure-credential');
  return { ...actual, createTenantContext: () => Promise.resolve({}) };
});

const fieldsByType: Record<string, string[] | Error> = {};
vi.mock('@rulebeat/core', () => ({
  getResourceTypeFields: (type: string) => {
    const outcome = fieldsByType[type];
    if (outcome instanceof Error) return Promise.reject(outcome);
    return Promise.resolve(outcome ?? []);
  },
}));

const { POST } = await import('@/app/api/schemas/route');

async function clearSchemaCache() {
  await execRaw('DELETE FROM schema_cache');
}

async function signInAsEditor(): Promise<void> {
  const result = await createUser({ email: 'editor@example.com', role: 'editor' });
  if ('error' in result) throw new Error(result.error);
  await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
}

describe('POST /api/schemas (P3-4b)', () => {
  beforeEach(async () => {
    await resetDb();
    await clearSchemaCache();
    mockAuth.mockReset();
    for (const key of Object.keys(fieldsByType)) delete fieldsByType[key];
    await signInAsEditor();
  });

  it('marks a type whose ARM call throws as "error", distinct from a genuinely empty schema', async () => {
    fieldsByType['microsoft.compute/virtualmachines'] = new Error('ECONNRESET');
    fieldsByType['microsoft.compute/disks'] = [];

    const res = await POST();
    expect(res.status).toBe(200);
    const json = await res.json() as { results: { type: string; status: string; error?: string }[] };

    const threw = json.results.find(r => r.type === 'microsoft.compute/virtualmachines');
    expect(threw?.status).toBe('error');
    expect(threw?.error).toBeTruthy();

    const empty = json.results.find(r => r.type === 'microsoft.compute/disks');
    expect(empty?.status).toBe('empty');
    expect(empty?.error).toBeUndefined();
  });

  it('marks a type with real fields as "ok" and caches them', async () => {
    fieldsByType['microsoft.compute/virtualmachines'] = ['id', 'name'];

    const res = await POST();
    const json = await res.json() as { results: { type: string; status: string; count?: number }[] };

    const ok = json.results.find(r => r.type === 'microsoft.compute/virtualmachines');
    expect(ok?.status).toBe('ok');
    expect(ok?.count).toBe(2);
  });
});
