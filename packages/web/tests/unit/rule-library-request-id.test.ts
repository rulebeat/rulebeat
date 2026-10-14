/**
 * #282: the id of the Library request a rule was approved from is written once, by the approval. A client
 * cannot set it through POST or PUT /api/rules, a copy of the rule does not inherit it, and an upgrade's
 * seeding never touches it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rule } from '@rulebeat/core';
import { execRaw, resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { dbReady, pgDb, rawSqlite } from '@/lib/db/client';
import { dbKind } from '@/lib/db/backend';
import { runSeeds } from '@/lib/db/migrate';
import { seedPg } from '@/lib/db/pg/seeds';
import { createRule, duplicateRule, loadRule, updateRule } from '@/lib/rules';
import type { ShippedCatalogue } from '@/lib/shipped-catalogue';
import { catalogueOf, shippedRule } from '../helpers/catalogue';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

vi.mock('@/lib/azure-credential', () => ({
  createTenantContext: () => Promise.reject(new Error('not configured in this test file')),
}));

const collection = await import('@/app/api/rules/route');
const item = await import('@/app/api/rules/[id]/route');

const dataDir = mkdtempSync(join(tmpdir(), 'rb-request-id-'));
const SHIPPED = 'request-id-shipped';

async function seed(catalogue: ShippedCatalogue): Promise<void> {
  await dbReady;
  if (dbKind === 'pg') await seedPg(pgDb!, dataDir, { skipOwnerBootstrap: true, catalogue });
  else runSeeds(rawSqlite!, dataDir, { skipOwnerBootstrap: true, catalogue });
}

let counter = 0;
const body = (extra: Record<string, unknown> = {}) => ({
  name: `request id rule ${++counter}`, description: 'a rule', category: 'security', severity: 'medium', enabled: false,
  scope: { level: 'subscription' }, resourceTypes: [], conditions: [], rawKql: 'resources | project id, name, type, location, resourceGroup, subscriptionId',
  ...extra,
});

const asJson = (method: string, payload: unknown) => new Request('http://localhost/api/rules', {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
});

async function storedWithRequest(requestId: string): Promise<Rule> {
  const made = await createRule({ ...body(), id: `request-id-${++counter}`, type: 'custom', libraryRequestId: requestId } as unknown as Rule);
  if (!made.ok) throw new Error(made.reason);
  return made.rule;
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  const editor = await createUser({ email: 'editor@example.com', role: 'admin' });
  if ('error' in editor) throw new Error(editor.error);
  await setPassword(editor.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: editor.user.id } });
});

describe('the Library request id on a rule', () => {
  it('is stored and read back when the approval creates the rule', async () => {
    const rule = await storedWithRequest('request-1');
    expect(rule.libraryRequestId).toBe('request-1');
    expect((await loadRule(rule.id))!.libraryRequestId).toBe('request-1');
  });

  it('cannot be set by POST /api/rules', async () => {
    const res = await collection.POST(asJson('POST', body({ libraryRequestId: 'forged' })));
    expect(res.status).toBe(201);
    const { id } = await res.json() as { id: string };
    expect((await loadRule(id))!.libraryRequestId).toBeUndefined();
  });

  it('cannot be changed or cleared by PUT /api/rules/[id]', async () => {
    const rule = await storedWithRequest('request-2');
    const edited = await item.PUT(asJson('PUT', { ...rule, name: `${rule.name} renamed`, libraryRequestId: 'forged' }), { params: Promise.resolve({ id: rule.id }) });
    expect(edited.status).toBe(200);
    expect(await loadRule(rule.id)).toMatchObject({ name: `${rule.name} renamed`, libraryRequestId: 'request-2' });

    const cleared = await item.PUT(asJson('PUT', { ...rule, libraryRequestId: undefined }), { params: Promise.resolve({ id: rule.id }) });
    expect(cleared.status).toBe(200);
    expect((await loadRule(rule.id))!.libraryRequestId).toBe('request-2');
  });

  it('is ignored by updateRule() even when a cast sneaks it into the changes', async () => {
    const rule = await storedWithRequest('request-5');
    const updated = await updateRule(rule.id, { name: `${rule.name} changed`, libraryRequestId: 'forged' } as never);
    expect(updated.ok).toBe(true);
    expect(await loadRule(rule.id)).toMatchObject({ name: `${rule.name} changed`, libraryRequestId: 'request-5' });
    expect((await updateRule(rule.id, { libraryRequestId: undefined } as never)).ok).toBe(true);
    expect((await loadRule(rule.id))!.libraryRequestId).toBe('request-5');
  });

  it('is not carried onto a duplicate, which is a new rule that came from no request', async () => {
    const rule = await storedWithRequest('request-3');
    const copy = (await duplicateRule(rule.id))!;
    expect(copy.libraryRequestId).toBeUndefined();
    expect((await loadRule(copy.id))!.libraryRequestId).toBeUndefined();
    expect((await loadRule(rule.id))!.libraryRequestId).toBe('request-3');
  });

  it('is left alone by seeding, when a shipped rule moves to a newer version', async () => {
    await seed(catalogueOf(shippedRule({ id: SHIPPED, version: '1.0.0', enabled: false })));
    expect((await loadRule(SHIPPED))!.libraryRequestId).toBeUndefined();
    await execRaw(`UPDATE rules SET library_request_id = 'request-4' WHERE id = '${SHIPPED}'`);

    await seed(catalogueOf(shippedRule({ id: SHIPPED, version: '1.1.0', enabled: false, definition: { name: 'Renamed by a newer version' } })));
    expect(await loadRule(SHIPPED)).toMatchObject({ name: 'Renamed by a newer version', version: '1.1.0', libraryRequestId: 'request-4' });
  });
});
