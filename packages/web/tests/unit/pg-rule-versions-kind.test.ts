/**
 * The same scenarios as rule-versions-kind.test.ts on Postgres, driven through `seedPg()` with an
 * injected catalogue. A built-in rule's kind is part of its versioned definition: an enabled rule
 * keeps the kind of the version it runs, and a disabled rule moves to a new version, kind included.
 *
 * Runs only under the Postgres CI job (RULEBEAT_TEST_PG_URL set); `tests/setup.ts` recreates the
 * `public` schema per test file and importing the client bootstraps it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { join, resolve } from 'node:path';
import { dbReady, pgDb } from '@/lib/db/client';
import { seedPg } from '@/lib/db/pg/seeds';
import type { RuleDefinition, ShippedCatalogue } from '@/lib/shipped-catalogue';
import { catalogueOf, shippedRule } from '../helpers/catalogue';

const REAL_DATA_DIR = join(resolve(__dirname, '..', '..'), 'data');
const ID = 'aaaaaaaa-0000-4000-8000-0000000000c1';

type Row = Record<string, unknown>;

const v1 = (kind: RuleDefinition['kind'] = 'state') => shippedRule({ id: ID, definition: { kind } });
const v2 = (kind: RuleDefinition['kind']) => shippedRule({
  id: ID, version: '2.0.0', releaseNote: 'Changed the kind.',
  definition: { kind, rawKql: 'Resources | where name == "new" | project id' },
});

async function seed(catalogue: ShippedCatalogue): Promise<void> {
  await seedPg(pgDb!, REAL_DATA_DIR, { skipOwnerBootstrap: true, catalogue });
}

async function row(): Promise<Row> {
  const res = await pgDb!.execute(sql`SELECT version, kind FROM rules WHERE id = ${ID}`);
  return res.rows[0] as Row;
}

describe.runIf(process.env.RULEBEAT_TEST_PG_URL)('postgres built-in rule kind', () => {
  beforeEach(async () => {
    await dbReady;
    // The client already seeded the real catalogue; every scenario starts from an empty rule set.
    await pgDb!.execute(sql`DELETE FROM rule_versions`);
    await pgDb!.execute(sql`DELETE FROM findings`);
    await pgDb!.execute(sql`DELETE FROM suppressions`);
    await pgDb!.execute(sql`DELETE FROM rules`);
  });

  describe('a shipped rule\'s kind', () => {
    it('arrives on a fresh install as the Advisory it ships as', async () => {
      await seed(catalogueOf(v1('advisory')));
      expect(await row()).toEqual({ version: '1.0.0', kind: 'advisory' });
    });

    it('arrives as a Problem when it ships as one', async () => {
      await seed(catalogueOf(v1()));
      expect(await row()).toEqual({ version: '1.0.0', kind: 'state' });
    });
  });

  describe('a new version that ships a different kind', () => {
    beforeEach(async () => {
      await seed(catalogueOf(v1()));
    });

    it('does not change an enabled rule, which keeps running the version it ran', async () => {
      await seed(catalogueOf(v2('advisory')));
      expect(await row()).toEqual({ version: '1.0.0', kind: 'state' });
    });

    it('moves a disabled rule to the new version, kind included', async () => {
      await pgDb!.execute(sql`UPDATE rules SET enabled = FALSE WHERE id = ${ID}`);
      await seed(catalogueOf(v2('advisory')));
      expect(await row()).toEqual({ version: '2.0.0', kind: 'advisory' });
    });
  });
});
