/**
 * Issue #176: whether a rule is a Problem or an Advisory belongs to the install, not to the shipped
 * definition, so seeding and version switching must never reset it, and an enabled Advisory must
 * not read as a tuned definition ("Before versioning") just because its kind differs from what ships.
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
import { loadRules, updateRule } from '@/lib/rules';
import { resetDb } from '../helpers/db';
import { catalogueOf, shippedRule } from '../helpers/catalogue';
import type { ShippedCatalogue } from '@/lib/shipped-catalogue';
import { planRuleSeeding, versionKey, type StoredRuleRow } from '@/lib/rule-versions';
import { BEFORE_VERSIONING } from '@/lib/before-versioning';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
const { PUT } = await import('@/app/api/rules/[id]/version/route');

const ID = 'aaaaaaaa-0000-4000-8000-0000000000a1';
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

describe('an Advisory built-in across versions', () => {
  it('stays Advisory when an admin switches version, forward and back', async () => {
    await updateRule(ID, { kind: 'advisory' });
    await seed(catalogueOf(v2));
    for (const version of ['2.0.0', '1.0.0']) {
      const res = await PUT(new Request('http://localhost/api/rules/x/version', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version }),
      }), params);
      expect(res.status).toBe(200);
      expect((await stored()).kind).toBe('advisory');
    }
  });

  it('stays Advisory when a disabled rule moves to a newer shipped version at startup', async () => {
    await updateRule(ID, { kind: 'advisory', enabled: false });
    await seed(catalogueOf(v2));
    const after = await stored();
    expect(after.version).toBe('2.0.0');
    expect(after.rawKql).toBe(v2.definition.rawKql);
    expect(after.kind).toBe('advisory');
  });

  it('stays Advisory across a restart with the same catalogue', async () => {
    await updateRule(ID, { kind: 'advisory' });
    await seed(catalogueOf(v1));
    expect((await stored()).kind).toBe('advisory');
  });
});

describe('planRuleSeeding with an Advisory row', () => {
  const rowOf = (over: Partial<StoredRuleRow>): StoredRuleRow => {
    const d = v1.definition;
    return {
      id: ID, name: d.name, description: d.description, category: d.category, severity: d.severity,
      enabled: true, scope: JSON.stringify(d.scope), resourceTypes: JSON.stringify(d.resourceTypes),
      conditions: JSON.stringify(d.conditions), conditionGroups: null, visualQuery: null, projectColumns: null,
      rawKql: d.rawKql, queryBackend: d.queryBackend, kind: 'advisory', graphQuery: null, logsQuery: null,
      type: 'builtin', pack: v1.pack, version: null, retiredAt: null, originRuleId: null, ...over,
    };
  };

  it('records an enabled Advisory with no version as the shipped version, not as Before versioning', () => {
    const actions = planRuleSeeding({ catalogue: catalogueOf(v1), rows: [rowOf({})], recorded: new Set() });
    expect(actions.map(a => a.action)).toContain('set-running');
    expect(JSON.stringify(actions)).not.toContain(BEFORE_VERSIONING);
  });

  it('hands the apply action the kind to keep', () => {
    const rec = new Set([versionKey(ID, '1.0.0')]);
    const actions = planRuleSeeding({
      catalogue: catalogueOf(v2), rows: [rowOf({ enabled: false, version: '1.0.0' })], recorded: rec,
    });
    expect(actions.find(a => a.action === 'apply')).toMatchObject({ kind: 'advisory' });
  });
});
