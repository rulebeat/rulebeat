/**
 * A built-in rule's kind is part of its versioned definition (ADR 0005, amended): RuleBeat sets it,
 * the install cannot change it, and a new version that ships a different kind reaches a rule the
 * same way any other change of definition does. An enabled rule keeps what it runs, kind included,
 * until someone switches it to the new version; a disabled rule moves to the new version on its own.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, dbReady, rawSqlite, pgDb } from '@/lib/db/client';
import { run } from '@/lib/db/exec';
import { rules, ruleVersions } from '@/lib/db/tables';
import { runSeeds } from '@/lib/db/migrate';
import { seedPg } from '@/lib/db/pg/seeds';
import { loadRules, switchRuleVersion, updateRule } from '@/lib/rules';
import { resetDb } from '../helpers/db';
import { catalogueOf, shippedRule } from '../helpers/catalogue';
import type { RuleDefinition, ShippedCatalogue } from '@/lib/shipped-catalogue';

const ID = 'aaaaaaaa-0000-4000-8000-0000000000c1';
const dataDir = join(resolve(__dirname, '..', '..'), 'data');

const v1 = (kind: RuleDefinition['kind'] = 'state') => shippedRule({ id: ID, definition: { kind } });
const v2 = (kind: RuleDefinition['kind']) => shippedRule({
  id: ID, version: '2.0.0', releaseNote: 'Changed the kind.',
  definition: { kind, rawKql: 'Resources | where name == "new" | project id' },
});

async function seed(catalogue: ShippedCatalogue): Promise<void> {
  await dbReady;
  if (pgDb) await seedPg(pgDb, dataDir, { skipOwnerBootstrap: true, catalogue });
  else runSeeds(rawSqlite!, dataDir, { skipOwnerBootstrap: true, catalogue });
}

const stored = async () => (await loadRules()).find(r => r.id === ID)!;

beforeEach(async () => {
  await resetDb();
  // resetDb() leaves recorded versions, and recording never overwrites one, so clear this rule's.
  await run(db.delete(ruleVersions).where(eq(ruleVersions.ruleId, ID)));
  await run(db.delete(rules).where(eq(rules.id, ID)));
});

describe('a shipped rule\'s kind', () => {
  it('arrives on a fresh install as the Advisory it ships as', async () => {
    await seed(catalogueOf(v1('advisory')));
    expect((await stored()).kind).toBe('advisory');
  });

  it('arrives as a Problem when it ships as one', async () => {
    await seed(catalogueOf(v1()));
    expect((await stored()).kind).toBe('state');
  });

  it('is never an Advisory on the Logs backend, whatever it declares', async () => {
    const logs = shippedRule({
      id: ID,
      definition: { queryBackend: 'log-analytics', kind: 'advisory', rawKql: null, logsQuery: { kql: 'AzureActivity | take 1' } as never },
    });
    await seed(catalogueOf(logs));
    expect((await stored()).kind).toBe('activity');
  });

  it('stays what it ships as across a restart of the same version', async () => {
    await seed(catalogueOf(v1('advisory')));
    await seed(catalogueOf(v1('advisory')));
    expect((await stored()).kind).toBe('advisory');
  });
});

describe('a new version that ships a different kind', () => {
  beforeEach(async () => {
    await seed(catalogueOf(v1()));
  });

  it('does not change an enabled rule, which keeps running the version it ran', async () => {
    await seed(catalogueOf(v2('advisory')));
    const rule = await stored();
    expect(rule.version).toBe('1.0.0');
    expect(rule.kind).toBe('state');
  });

  it('moves a disabled rule to the new version, kind included', async () => {
    await updateRule(ID, { enabled: false });
    await seed(catalogueOf(v2('advisory')));
    const rule = await stored();
    expect(rule.version).toBe('2.0.0');
    expect(rule.kind).toBe('advisory');
  });

  it('reaches an enabled rule when someone switches it to the new version, and goes back with it', async () => {
    await seed(catalogueOf(v2('advisory')));
    expect(await switchRuleVersion(ID, '2.0.0')).toMatchObject({ ok: true });
    expect((await stored()).kind).toBe('advisory');
    expect(await switchRuleVersion(ID, '1.0.0')).toMatchObject({ ok: true });
    expect((await stored()).kind).toBe('state');
  });
});
