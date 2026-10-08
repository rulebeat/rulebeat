/**
 * Issue #181: a shipped rule can declare its kind, but only as what a brand-new install starts
 * with. Kind belongs to the install (ADR 0005),
 * so seeding reads the declaration when it first inserts the rule and never again: not on a restart,
 * not when a disabled rule moves to a newer version, not when a newer version declares something else.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, dbReady, rawSqlite, pgDb } from '@/lib/db/client';
import { run } from '@/lib/db/exec';
import { rules } from '@/lib/db/tables';
import { runSeeds } from '@/lib/db/migrate';
import { seedPg } from '@/lib/db/pg/seeds';
import { loadRules, updateRule } from '@/lib/rules';
import { resetDb } from '../helpers/db';
import { catalogueOf, shippedRule } from '../helpers/catalogue';
import type { ShippedCatalogue } from '@/lib/shipped-catalogue';

const ID = 'aaaaaaaa-0000-4000-8000-0000000000c1';
const dataDir = join(resolve(__dirname, '..', '..'), 'data');
const ADVISORY_DEFAULTS = { kind: 'advisory' } as const;

const v1 = (installDefaults?: NonNullable<ReturnType<typeof shippedRule>['installDefaults']>) =>
  shippedRule({ id: ID, installDefaults });
const v2 = (installDefaults?: NonNullable<ReturnType<typeof shippedRule>['installDefaults']>) =>
  shippedRule({
    id: ID, version: '2.0.0', releaseNote: 'Changed the query.', installDefaults,
    definition: { rawKql: 'Resources | where name == "new" | project id' },
  });

async function seed(catalogue: ShippedCatalogue): Promise<void> {
  await dbReady;
  if (pgDb) await seedPg(pgDb, dataDir, { skipOwnerBootstrap: true, catalogue });
  else runSeeds(rawSqlite!, dataDir, { skipOwnerBootstrap: true, catalogue });
}

const stored = async () => (await loadRules()).find(r => r.id === ID)!;

beforeEach(async () => {
  await resetDb();
  await run(db.delete(rules).where(eq(rules.id, ID)));
});

describe('a shipped rule that declares its kind', () => {
  it('arrives on a fresh install as an Advisory', async () => {
    await seed(catalogueOf(v1(ADVISORY_DEFAULTS)));
    expect((await stored()).kind).toBe('advisory');
  });

  it('arrives as a Problem when it declares nothing', async () => {
    await seed(catalogueOf(v1()));
    expect((await stored()).kind).toBe('state');
  });

  it('is never an Advisory on the Logs backend, whatever it declares', async () => {
    const logs = shippedRule({
      id: ID, installDefaults: { kind: 'advisory' },
      definition: { queryBackend: 'log-analytics', kind: 'activity', rawKql: null, logsQuery: { kql: 'AzureActivity | take 1' } as never },
    });
    await seed(catalogueOf(logs));
    expect((await stored()).kind).toBe('activity');
  });
});

describe('an install that switched the shipped Advisory to a Problem', () => {
  beforeEach(async () => {
    await seed(catalogueOf(v1(ADVISORY_DEFAULTS)));
    await updateRule(ID, { kind: 'state' });
  });

  it('keeps Problem through an upgrade that ships a new version of the rule it still runs', async () => {
    await seed(catalogueOf(v2(ADVISORY_DEFAULTS)));
    const rule = await stored();
    expect(rule.version).toBe('1.0.0');
    expect(rule.kind).toBe('state');
  });

  it('keeps Problem when a disabled rule moves to the new version', async () => {
    await updateRule(ID, { enabled: false });
    await seed(catalogueOf(v2(ADVISORY_DEFAULTS)));
    const rule = await stored();
    expect(rule.version).toBe('2.0.0');
    expect(rule.kind).toBe('state');
  });

  it('keeps Problem across a restart of the same version', async () => {
    await seed(catalogueOf(v1(ADVISORY_DEFAULTS)));
    expect((await stored()).kind).toBe('state');
  });
});

describe('an install that already has the shipped rule as a Problem', () => {
  beforeEach(async () => {
    await seed(catalogueOf(v1()));
  });

  it('is never made an Advisory by an upgrade whose version now declares Advisory', async () => {
    await seed(catalogueOf(v2(ADVISORY_DEFAULTS)));
    expect((await stored()).kind).toBe('state');
  });

  it('is not made an Advisory when a disabled rule moves to the version that declares Advisory', async () => {
    await updateRule(ID, { enabled: false });
    await seed(catalogueOf(v2(ADVISORY_DEFAULTS)));
    const rule = await stored();
    expect(rule.version).toBe('2.0.0');
    expect(rule.kind).toBe('state');
  });
});
