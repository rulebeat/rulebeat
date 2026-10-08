/**
 * Issue #181 on Postgres: the same scenarios as rule-versions-install-kind.test.ts, driven through
 * `seedPg()` with an injected catalogue. A shipped rule's declared kind and Deadline and Group
 * columns are read when the rule is first inserted and never again, so an install that switched it
 * to a Problem keeps that through an upgrade, and a Problem is never made an Advisory.
 *
 * Runs only under the Postgres CI job (RULEBEAT_TEST_PG_URL set); `tests/setup.ts` recreates the
 * `public` schema per test file and importing the client bootstraps it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { join, resolve } from 'node:path';
import { dbReady, pgDb } from '@/lib/db/client';
import { seedPg } from '@/lib/db/pg/seeds';
import type { RuleInstallDefaults, ShippedCatalogue } from '@/lib/shipped-catalogue';
import { catalogueOf, shippedRule } from '../helpers/catalogue';

const REAL_DATA_DIR = join(resolve(__dirname, '..', '..'), 'data');
const ID = 'aaaaaaaa-0000-4000-8000-0000000000c1';
const ADVISORY_DEFAULTS: RuleInstallDefaults = { kind: 'advisory', deadlineField: 'retirementDate', groupField: 'retirementFeatureName' };

type Row = Record<string, unknown>;

const v1 = (installDefaults?: RuleInstallDefaults) => shippedRule({ id: ID, installDefaults });
const v2 = (installDefaults?: RuleInstallDefaults) => shippedRule({
  id: ID, version: '2.0.0', releaseNote: 'Changed the query.', installDefaults,
  definition: { rawKql: 'Resources | where name == "new" | project id' },
});

async function seed(catalogue: ShippedCatalogue): Promise<void> {
  await seedPg(pgDb!, REAL_DATA_DIR, { skipOwnerBootstrap: true, catalogue });
}

async function row(): Promise<Row> {
  const res = await pgDb!.execute(sql`SELECT version, kind, deadline_field, group_field FROM rules WHERE id = ${ID}`);
  return res.rows[0] as Row;
}

describe.runIf(process.env.RULEBEAT_TEST_PG_URL)('postgres rule install kind', () => {
  beforeEach(async () => {
    await dbReady;
    // The client already seeded the real catalogue; every scenario starts from an empty rule set.
    await pgDb!.execute(sql`DELETE FROM rule_versions`);
    await pgDb!.execute(sql`DELETE FROM findings`);
    await pgDb!.execute(sql`DELETE FROM suppressions`);
    await pgDb!.execute(sql`DELETE FROM rules`);
  });

  describe('a shipped rule that declares its kind', () => {
    it('arrives on a fresh install as an Advisory with its Deadline and Group columns', async () => {
      await seed(catalogueOf(v1(ADVISORY_DEFAULTS)));
      expect(await row()).toEqual({ version: '1.0.0', kind: 'advisory', deadline_field: 'retirementDate', group_field: 'retirementFeatureName' });
    });

    it('arrives as a Problem with no columns when it declares nothing', async () => {
      await seed(catalogueOf(v1()));
      expect(await row()).toEqual({ version: '1.0.0', kind: 'state', deadline_field: null, group_field: null });
    });

    it('is still a Problem when it names columns but no kind', async () => {
      await seed(catalogueOf(v1({ deadlineField: 'retirementDate', groupField: 'retirementFeatureName' })));
      expect(await row()).toMatchObject({ kind: 'state', deadline_field: null, group_field: null });
    });
  });

  describe('an install that switched the shipped Advisory to a Problem', () => {
    beforeEach(async () => {
      await seed(catalogueOf(v1(ADVISORY_DEFAULTS)));
      await pgDb!.execute(sql`UPDATE rules SET kind = 'state' WHERE id = ${ID}`);
    });

    it('keeps Problem through an upgrade that ships a new version of the rule it still runs', async () => {
      await seed(catalogueOf(v2(ADVISORY_DEFAULTS)));
      expect(await row()).toMatchObject({ version: '1.0.0', kind: 'state' });
    });

    it('keeps Problem when a disabled rule moves to the new version, with the columns it had', async () => {
      await pgDb!.execute(sql`UPDATE rules SET enabled = FALSE WHERE id = ${ID}`);
      await seed(catalogueOf(v2(ADVISORY_DEFAULTS)));
      expect(await row()).toMatchObject({ version: '2.0.0', kind: 'state', deadline_field: 'retirementDate' });
    });

    it('keeps Problem across a restart of the same version', async () => {
      await seed(catalogueOf(v1(ADVISORY_DEFAULTS)));
      expect(await row()).toMatchObject({ kind: 'state' });
    });
  });

  describe('an install that already has the shipped rule as a Problem', () => {
    beforeEach(async () => {
      await seed(catalogueOf(v1()));
    });

    it('is never made an Advisory by an upgrade whose version now declares Advisory', async () => {
      await seed(catalogueOf(v2(ADVISORY_DEFAULTS)));
      expect(await row()).toEqual({ version: '1.0.0', kind: 'state', deadline_field: null, group_field: null });
    });

    it('is not made an Advisory when a disabled rule moves to the version that declares Advisory', async () => {
      await pgDb!.execute(sql`UPDATE rules SET enabled = FALSE WHERE id = ${ID}`);
      await seed(catalogueOf(v2(ADVISORY_DEFAULTS)));
      expect(await row()).toEqual({ version: '2.0.0', kind: 'state', deadline_field: null, group_field: null });
    });
  });
});
