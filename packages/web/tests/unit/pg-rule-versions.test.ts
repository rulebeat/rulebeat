/**
 * Ticket #163 on Postgres: the same scenarios as rule-versions-seeding.test.ts, driven through
 * `seedPg()` with an injected catalogue. Both seeders execute one shared plan (`planRuleSeeding()`),
 * and this file is what proves the Postgres half of that, including that findings, their ages and
 * suppressions survive what an upgrade does to a rule row.
 *
 * Runs only under the Postgres CI job (RULEBEAT_TEST_PG_URL set); `tests/setup.ts` recreates the
 * `public` schema per test file and importing the client bootstraps it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { join, resolve } from 'node:path';
import { dbReady, pgDb } from '@/lib/db/client';
import { seedPg } from '@/lib/db/pg/seeds';
import { BEFORE_VERSIONING, BEFORE_VERSIONING_SORT_KEY, versionSortKey } from '@/lib/rule-versions';
import type { ShippedCatalogue } from '@/lib/shipped-catalogue';
import { catalogueOf, shippedRule } from '../helpers/catalogue';

const REAL_DATA_DIR = join(resolve(__dirname, '..', '..'), 'data');
const APRL_VERSION = '2026-06-08T13:06:47Z';
const CORE_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const GRAPH_ID = 'cred:app-secret-expiring';
const SHIPPED_GRAPH = { path: 'applications', expand: { arrayField: 'passwordCredentials', dateField: 'endDateTime', itemIdField: 'keyId', resourceType: 'microsoft.graph/application/secret', bands: [{ maxDays: 30, severity: 'high' }] } };
const TUNED_GRAPH = { path: 'applications', filter: "startswith(displayName,'internal-')" };

type Row = Record<string, unknown>;

async function q(query: ReturnType<typeof sql>): Promise<Row[]> {
  const res = await pgDb!.execute(query);
  return res.rows as Row[];
}

async function seed(catalogue: ShippedCatalogue): Promise<void> {
  await seedPg(pgDb!, REAL_DATA_DIR, { skipOwnerBootstrap: true, catalogue });
}

async function row(id: string): Promise<Row> {
  const [r] = await q(sql`SELECT * FROM rules WHERE id = ${id}`);
  return r as Row;
}

async function versionsOf(id: string): Promise<string[]> {
  return (await q(sql`SELECT version FROM rule_versions WHERE rule_id = ${id} ORDER BY version`)).map(r => r.version as string);
}

async function definitionOf(id: string, version: string): Promise<Row> {
  const [r] = await q(sql`SELECT definition FROM rule_versions WHERE rule_id = ${id} AND version = ${version}`);
  return JSON.parse(r!.definition as string) as Row;
}

/** Puts the database back in the state an install had before versions existed. */
async function forgetVersions(): Promise<void> {
  await pgDb!.execute(sql`UPDATE rules SET version = NULL, retired_at = NULL, origin_rule_id = NULL, origin_version = NULL`);
  await pgDb!.execute(sql`DELETE FROM rule_versions`);
}

async function insertCustom(id: string, type: string): Promise<void> {
  await pgDb!.execute(sql`
    INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, type)
    VALUES (${id}, ${`Mine ${type}`}, 'd', 'security', 'low', TRUE, '{"level":"resource"}', '[]', '[]', ${type})
  `);
}

const identity = () => shippedRule({
  id: GRAPH_ID,
  definition: { name: 'App secret expiring', category: 'identity', queryBackend: 'microsoft-graph', rawKql: null, graphQuery: SHIPPED_GRAPH as never, resourceTypes: [] },
});

describe.runIf(process.env.RULEBEAT_TEST_PG_URL)('postgres rule versions', () => {
  beforeEach(async () => {
    await dbReady;
    // The client already seeded the real catalogue; every scenario starts from an empty rule set.
    await pgDb!.execute(sql`DELETE FROM rule_versions`);
    await pgDb!.execute(sql`DELETE FROM findings`);
    await pgDb!.execute(sql`DELETE FROM suppressions`);
    await pgDb!.execute(sql`DELETE FROM rules`);
  });

  describe('a fresh install', () => {
    it('records the shipped version of every rule and runs it', async () => {
      const aprl = shippedRule({ id: 'aprl-1', pack: 'aprl-v2', versionScheme: 'upstream-commit-date', version: APRL_VERSION, releaseNote: 'APRL sync.', upstreamRef: '1824eb5958d11482f6e23c231f0cb1d2d5bd44f6', enabled: false });
      await seed(catalogueOf(shippedRule({ id: 'core-1' }), aprl));

      expect((await row('core-1')).version).toBe('1.0.0');
      expect(await versionsOf('core-1')).toEqual(['1.0.0']);
      expect((await row('aprl-1')).version).toBe(APRL_VERSION);
      const [stored] = await q(sql`SELECT release_note, upstream_ref FROM rule_versions WHERE rule_id = 'aprl-1'`);
      expect(stored).toEqual({ release_note: 'APRL sync.', upstream_ref: '1824eb5958d11482f6e23c231f0cb1d2d5bd44f6' });
      expect((await definitionOf('core-1', '1.0.0')).name).toBe('Test rule');
      expect(await q(sql`SELECT version, sort_key, first_seen_at FROM rule_versions WHERE rule_id IN ('core-1', 'aprl-1') ORDER BY rule_id`)).toEqual([
        { version: APRL_VERSION, sort_key: versionSortKey('upstream-commit-date', APRL_VERSION), first_seen_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
        { version: '1.0.0', sort_key: versionSortKey('semver', '1.0.0'), first_seen_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
      ]);
    });

    it('enables a rule exactly as the catalogue says', async () => {
      await seed(catalogueOf(shippedRule({ id: 'on', enabled: true }), shippedRule({ id: 'off', enabled: false })));
      expect([(await row('on')).enabled, (await row('off')).enabled]).toEqual([true, false]);
    });

    it('records Core at 1.0.0 and APRL at the upstream commit time from what this build ships', async () => {
      await pgDb!.execute(sql`DELETE FROM rules`);
      await seedPg(pgDb!, REAL_DATA_DIR, { skipOwnerBootstrap: true });

      const [core] = await q(sql`SELECT COUNT(*) AS n FROM rules WHERE pack = 'rulebeat-core' AND version = '1.0.0'`);
      const [coreOther] = await q(sql`SELECT COUNT(*) AS n FROM rules WHERE pack = 'rulebeat-core' AND version IS DISTINCT FROM '1.0.0'`);
      const [aprl] = await q(sql`SELECT COUNT(*) AS n FROM rules WHERE pack = 'aprl-v2' AND version = ${APRL_VERSION}`);
      const [aprlOther] = await q(sql`SELECT COUNT(*) AS n FROM rules WHERE pack = 'aprl-v2' AND version IS DISTINCT FROM ${APRL_VERSION}`);
      expect(Number(core!.n)).toBeGreaterThan(0);
      expect(Number(coreOther!.n)).toBe(0);
      expect(Number(aprl!.n)).toBe(143);
      expect(Number(aprlOther!.n)).toBe(0);
      const [unversioned] = await q(sql`SELECT COUNT(*) AS n FROM rules r WHERE NOT EXISTS (SELECT 1 FROM rule_versions v WHERE v.rule_id = r.id AND v.version = r.version)`);
      expect(Number(unversioned!.n)).toBe(0);
    });
  });

  describe('a changed shipped definition', () => {
    const v1 = () => shippedRule({ id: CORE_ID, version: '1.0.0', definition: { name: 'Old name', severity: 'low' } });
    const v2 = () => shippedRule({ id: CORE_ID, version: '1.1.0', releaseNote: 'Raised severity.', definition: { name: 'New name', severity: 'high' } });

    it('is recorded but not applied to an enabled rule, on every restart', async () => {
      await seed(catalogueOf(v1()));
      for (let restart = 0; restart < 3; restart++) await seed(catalogueOf(v2()));

      expect(await versionsOf(CORE_ID)).toEqual(['1.0.0', '1.1.0']);
      const r = await row(CORE_ID);
      expect([r.name, r.severity, r.version]).toEqual(['Old name', 'low', '1.0.0']);
      expect(await definitionOf(CORE_ID, '1.1.0')).toMatchObject({ name: 'New name', severity: 'high' });
    });

    it('is applied to a disabled rule, which stays disabled, with the admin\'s own fields untouched', async () => {
      await seed(catalogueOf(v1()));
      await pgDb!.execute(sql`UPDATE rules SET enabled = FALSE, tags = '["mine"]', last_run_status = 'success' WHERE id = ${CORE_ID}`);
      await seed(catalogueOf(v2()));

      const r = await row(CORE_ID);
      expect([r.name, r.severity, r.version, r.enabled, r.tags, r.last_run_status]).toEqual(['New name', 'high', '1.1.0', false, '["mine"]', 'success']);
    });

    it('never moves a disabled rule back to an older version', async () => {
      await seed(catalogueOf(v2()));
      await pgDb!.execute(sql`UPDATE rules SET enabled = FALSE WHERE id = ${CORE_ID}`);
      await seed(catalogueOf(v1()));
      expect([(await row(CORE_ID)).name, (await row(CORE_ID)).version]).toEqual(['New name', '1.1.0']);
    });

    it('orders APRL commit timestamps, so two syncs on one day still move a disabled rule forward', async () => {
      const at = (version: string, name: string) => shippedRule({ id: 'a', pack: 'aprl-v2', versionScheme: 'upstream-commit-date', version, enabled: false, definition: { name } });
      await seed(catalogueOf(at('2026-06-08T09:00:00Z', 'morning')));
      await seed(catalogueOf(at(APRL_VERSION, 'afternoon')));
      expect([(await row('a')).name, (await row('a')).version]).toEqual(['afternoon', APRL_VERSION]);
    });
  });

  describe('a rule no pack ships any more', () => {
    it('is marked retired, keeps running, keeps its definition and keeps its findings', async () => {
      await seed(catalogueOf(shippedRule({ id: 'gone' }), shippedRule({ id: 'stays', definition: { name: 'Other' } })));
      await pgDb!.execute(sql`
        INSERT INTO findings (fingerprint, rule_id, category, severity, subscription_id, title, status, first_seen_at, last_seen_at, times_seen)
        VALUES ('fp-gone', 'gone', 'security', 'high', 'sub', 'A finding', 'active', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 12)
      `);
      await seed(catalogueOf(shippedRule({ id: 'stays', definition: { name: 'Other' } })));

      const gone = await row('gone');
      expect(gone.retired_at).toEqual(expect.any(String));
      expect([gone.enabled, gone.type, gone.name, gone.version]).toEqual([true, 'builtin', 'Test rule', '1.0.0']);
      expect((await row('stays')).retired_at).toBeNull();
      expect(await q(sql`SELECT status, first_seen_at, last_seen_at, times_seen FROM findings WHERE fingerprint = 'fp-gone'`)).toEqual([
        { status: 'active', first_seen_at: '2026-01-01T00:00:00.000Z', last_seen_at: '2026-02-01T00:00:00.000Z', times_seen: 12 },
      ]);
    });

    it('is not retired when the packs were not looked at or the pack file could not be read', async () => {
      await seed(catalogueOf(shippedRule({ id: 'aprl-1', pack: 'aprl-v2', versionScheme: 'upstream-commit-date', version: APRL_VERSION })));
      await seed({ rules: [], packsDirRead: false, unreadablePacks: [] });
      await seed({ rules: [], packsDirRead: true, unreadablePacks: ['aprl-v2'] });
      expect((await row('aprl-1')).retired_at).toBeNull();
    });

    it('stops being retired when a later release ships it again', async () => {
      await seed(catalogueOf(shippedRule({ id: 'back' }), shippedRule({ id: 'other' })));
      await seed(catalogueOf(shippedRule({ id: 'other' })));
      expect((await row('back')).retired_at).not.toBeNull();
      await seed(catalogueOf(shippedRule({ id: 'back' }), shippedRule({ id: 'other' })));
      expect((await row('back')).retired_at).toBeNull();
    });

    it('is never read from a custom or community rule', async () => {
      await seed(catalogueOf(shippedRule({ id: 'core-1' })));
      await insertCustom('mine-custom', 'custom');
      await insertCustom('mine-community', 'community');
      await seed(catalogueOf(shippedRule({ id: 'core-1' })));
      for (const type of ['custom', 'community']) {
        const r = await row(`mine-${type}`);
        expect([r.retired_at, r.version, r.type, r.name]).toEqual([null, null, type, `Mine ${type}`]);
      }
      expect(await versionsOf('mine-custom')).toEqual([]);
    });
  });

  describe('the first start after versions shipped', () => {
    it('records the version a row already runs when its stored definition is the shipped one', async () => {
      await seed(catalogueOf(shippedRule({ id: CORE_ID })));
      await forgetVersions();
      await seed(catalogueOf(shippedRule({ id: CORE_ID })));
      expect((await row(CORE_ID)).version).toBe('1.0.0');
      expect(await versionsOf(CORE_ID)).toEqual(['1.0.0']);
    });

    it('keeps a differing stored definition running as "Before versioning" and still records the shipped one', async () => {
      await seed(catalogueOf(shippedRule({ id: CORE_ID })));
      await forgetVersions();
      await pgDb!.execute(sql`UPDATE rules SET severity = 'critical', description = 'tuned by an admin' WHERE id = ${CORE_ID}`);
      await seed(catalogueOf(shippedRule({ id: CORE_ID })));

      const r = await row(CORE_ID);
      expect([r.version, r.severity, r.description]).toEqual([BEFORE_VERSIONING, 'critical', 'tuned by an admin']);
      expect(await versionsOf(CORE_ID)).toEqual(['1.0.0', BEFORE_VERSIONING]);
      expect(await definitionOf(CORE_ID, BEFORE_VERSIONING)).toMatchObject({ severity: 'critical', description: 'tuned by an admin' });
      expect(await definitionOf(CORE_ID, '1.0.0')).toMatchObject({ severity: 'medium' });
    });

    it('keeps an enabled "Before versioning" rule there when a newer version ships', async () => {
      await seed(catalogueOf(shippedRule({ id: CORE_ID })));
      await forgetVersions();
      await pgDb!.execute(sql`UPDATE rules SET severity = 'critical' WHERE id = ${CORE_ID}`);
      await seed(catalogueOf(shippedRule({ id: CORE_ID })));
      await seed(catalogueOf(shippedRule({ id: CORE_ID, version: '1.1.0', definition: { severity: 'low' } })));
      const r = await row(CORE_ID);
      expect([r.version, r.severity, r.enabled]).toEqual([BEFORE_VERSIONING, 'critical', true]);
      expect(await versionsOf(CORE_ID)).toEqual(['1.0.0', '1.1.0', BEFORE_VERSIONING]);
    });

    it('moves a disabled rule whose stored definition differs to the shipped version, after recording the stored one', async () => {
      await seed(catalogueOf(shippedRule({ id: CORE_ID })));
      await forgetVersions();
      await pgDb!.execute(sql`UPDATE rules SET name = 'Renamed by hand', severity = 'critical', enabled = FALSE WHERE id = ${CORE_ID}`);
      await seed(catalogueOf(shippedRule({ id: CORE_ID })));

      const r = await row(CORE_ID);
      expect([r.name, r.severity, r.version, r.enabled]).toEqual(['Test rule', 'medium', '1.0.0', false]);
      expect(await versionsOf(CORE_ID)).toEqual(['1.0.0', BEFORE_VERSIONING]);
      expect(await definitionOf(CORE_ID, BEFORE_VERSIONING)).toMatchObject({ name: 'Renamed by hand', severity: 'critical' });
      expect(await q(sql`SELECT sort_key FROM rule_versions WHERE rule_id = ${CORE_ID} AND version = ${BEFORE_VERSIONING}`)).toEqual([{ sort_key: BEFORE_VERSIONING_SORT_KEY }]);
    });

    it('moves a rule left on "Before versioning" to the newest shipped version once it is disabled', async () => {
      await seed(catalogueOf(shippedRule({ id: CORE_ID })));
      await forgetVersions();
      await pgDb!.execute(sql`UPDATE rules SET severity = 'critical' WHERE id = ${CORE_ID}`);
      await seed(catalogueOf(shippedRule({ id: CORE_ID })));
      expect((await row(CORE_ID)).version).toBe(BEFORE_VERSIONING);

      await pgDb!.execute(sql`UPDATE rules SET enabled = FALSE WHERE id = ${CORE_ID}`);
      await seed(catalogueOf(shippedRule({ id: CORE_ID })));
      const r = await row(CORE_ID);
      expect([r.version, r.severity, r.enabled]).toEqual(['1.0.0', 'medium', false]);
      expect(await definitionOf(CORE_ID, BEFORE_VERSIONING)).toMatchObject({ severity: 'critical' });
    });

    it('records a dropped rule\'s stored definition and retires it', async () => {
      await seed(catalogueOf(shippedRule({ id: 'gone' }), shippedRule({ id: 'stays', definition: { name: 'Other' } })));
      await forgetVersions();
      await seed(catalogueOf(shippedRule({ id: 'stays', definition: { name: 'Other' } })));
      const gone = await row('gone');
      expect([gone.version, gone.enabled]).toEqual([BEFORE_VERSIONING, true]);
      expect(gone.retired_at).not.toBeNull();
      expect(await versionsOf('gone')).toEqual([BEFORE_VERSIONING]);
    });
  });

  describe('an Identity built-in', () => {
    async function tune(): Promise<void> {
      await seed(catalogueOf(identity()));
      await forgetVersions();
      await pgDb!.execute(sql`UPDATE rules SET graph_query = ${JSON.stringify(TUNED_GRAPH)} WHERE id = ${GRAPH_ID}`);
    }

    it('with a tuned Graph query becomes a custom rule with the same id, query, findings and suppressions, and is not re-seeded', async () => {
      await tune();
      await pgDb!.execute(sql`
        INSERT INTO findings (fingerprint, rule_id, category, severity, subscription_id, title, status, first_seen_at, last_seen_at, times_seen)
        VALUES ('fp-graph', ${GRAPH_ID}, 'identity', 'high', 'sub', 'A secret expires', 'active', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 7)
      `);
      await pgDb!.execute(sql`
        INSERT INTO suppressions (id, fingerprint, resource_id, reason, suppressed_at)
        VALUES ('sup-1', 'fp-graph', 'app-1', 'Accepted risk', '2026-01-02T00:00:00.000Z')
      `);
      for (let restart = 0; restart < 2; restart++) await seed(catalogueOf(identity()));

      const r = await row(GRAPH_ID);
      expect([r.type, r.pack, r.version, r.origin_rule_id, r.origin_version, r.enabled]).toEqual(['custom', null, null, GRAPH_ID, '1.0.0', true]);
      expect(JSON.parse(r.graph_query as string)).toEqual(TUNED_GRAPH);
      expect(await versionsOf(GRAPH_ID)).toEqual([]);
      expect(await q(sql`SELECT COUNT(*) AS n FROM rules WHERE id = ${GRAPH_ID}`)).toEqual([{ n: '1' }]);
      expect(await q(sql`SELECT first_seen_at, times_seen FROM findings WHERE fingerprint = 'fp-graph'`)).toEqual([
        { first_seen_at: '2026-01-01T00:00:00.000Z', times_seen: 7 },
      ]);
      expect(await q(sql`SELECT reason FROM suppressions WHERE fingerprint = 'fp-graph'`)).toEqual([{ reason: 'Accepted risk' }]);
    });

    it('with the shipped Graph query stays a built-in', async () => {
      await seed(catalogueOf(identity()));
      await forgetVersions();
      await seed(catalogueOf(identity()));
      const r = await row(GRAPH_ID);
      expect([r.type, r.version, r.origin_rule_id]).toEqual(['builtin', '1.0.0', null]);
    });

    it('with no Graph query yet gets the shipped query and stays a built-in', async () => {
      await seed(catalogueOf(identity()));
      await forgetVersions();
      await pgDb!.execute(sql`UPDATE rules SET graph_query = NULL, query_backend = 'resource-graph', kind = 'state' WHERE id = ${GRAPH_ID}`);
      await seed(catalogueOf(identity()));
      const r = await row(GRAPH_ID);
      expect([r.type, r.query_backend, r.version]).toEqual(['builtin', 'microsoft-graph', '1.0.0']);
      expect(JSON.parse(r.graph_query as string)).toEqual(SHIPPED_GRAPH);
    });
  });

  describe('seeding twice', () => {
    it('changes nothing the second time', async () => {
      const catalogue = catalogueOf(
        shippedRule({ id: 'a' }),
        shippedRule({ id: 'b', pack: 'aprl-v2', versionScheme: 'upstream-commit-date', version: APRL_VERSION, enabled: false, definition: { name: 'B' } }),
      );
      await seed(catalogue);
      const snapshot = async () => JSON.stringify([
        await q(sql`SELECT * FROM rules ORDER BY id`),
        await q(sql`SELECT * FROM rule_versions ORDER BY rule_id, version`),
      ]);
      const first = await snapshot();
      await seed(catalogue);
      expect(await snapshot()).toBe(first);
    });

    it('skips a rule that cannot be written without losing the others', async () => {
      const broken = shippedRule({ id: 'broken' });
      (broken.definition as { name: unknown }).name = null;
      await seed(catalogueOf(broken, shippedRule({ id: 'fine', definition: { name: 'Fine' } })));
      expect((await row('fine')).version).toBe('1.0.0');
      expect(await row('broken')).toBeUndefined();
    });
  });
});
