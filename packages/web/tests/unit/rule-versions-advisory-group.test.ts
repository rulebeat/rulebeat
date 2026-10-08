/**
 * Issue #178: the Group column belongs to the install, not to the shipped definition, so a
 * version switch, a startup move of a disabled rule and a restart must never reset it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, dbReady, rawSqlite, pgDb } from '@/lib/db/client';
import { run } from '@/lib/db/exec';
import { rules } from '@/lib/db/tables';
import { runSeeds } from '@/lib/db/migrate';
import { seedPg } from '@/lib/db/pg/seeds';
import { createUser } from '@/lib/db/users';
import { duplicateRule, loadRules, updateRule } from '@/lib/rules';
import { resetDb } from '../helpers/db';
import { catalogueOf, shippedRule } from '../helpers/catalogue';
import type { ShippedCatalogue } from '@/lib/shipped-catalogue';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
const { PUT } = await import('@/app/api/rules/[id]/version/route');

const ID = 'aaaaaaaa-0000-4000-8000-0000000000b2';
const dataDir = join(resolve(__dirname, '..', '..'), 'data');
const params = { params: Promise.resolve({ id: ID }) };
const v1 = shippedRule({ id: ID });
const v2 = shippedRule({ id: ID, version: '2.0.0', releaseNote: 'Changed the query.', definition: { rawKql: 'Resources | where name == "new" | project id' } });

async function seed(catalogue: ShippedCatalogue): Promise<void> {
  await dbReady;
  if (pgDb) await seedPg(pgDb, dataDir, { skipOwnerBootstrap: true, catalogue });
  else runSeeds(rawSqlite!, dataDir, { skipOwnerBootstrap: true, catalogue });
}

const stored = async () => (await loadRules()).find(r => r.id === ID)!;

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  await run(db.delete(rules).where(eq(rules.id, ID)));
  await seed(catalogueOf(v1));
  const result = await createUser({ email: 'admin@example.com', role: 'admin' });
  if ('error' in result) throw new Error(result.error);
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
});

describe('a Group column on a built-in across versions', () => {
  it('survives an admin switching version, forward and back', async () => {
    await updateRule(ID, { kind: 'advisory', groupField: 'owner' });
    await seed(catalogueOf(v2));
    for (const version of ['2.0.0', '1.0.0']) {
      const res = await PUT(new Request('http://localhost/api/rules/x/version', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version }),
      }), params);
      expect(res.status).toBe(200);
      expect((await stored()).groupField).toBe('owner');
    }
  });

  it('survives a disabled rule moving to a newer shipped version at startup', async () => {
    await updateRule(ID, { kind: 'advisory', groupField: 'owner', enabled: false });
    await seed(catalogueOf(v2));
    const after = await stored();
    expect(after.version).toBe('2.0.0');
    expect(after.groupField).toBe('owner');
  });

  it('survives a restart, and is copied by a duplicate', async () => {
    await updateRule(ID, { kind: 'advisory', groupField: 'owner' });
    await seed(catalogueOf(v1));
    expect((await stored()).groupField).toBe('owner');
    const copy = await duplicateRule(ID);
    expect(copy?.groupField).toBe('owner');
  });
});
