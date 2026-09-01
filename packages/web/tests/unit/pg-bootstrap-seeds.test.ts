/**
 * Issue #73 Phase 1: the Postgres schema bootstrap and seed path.
 *
 * The backend-agnostic block asserts the seeded baseline every fresh install must have (built-in
 * rules, pack rules, the five built-in categories, the starter dashboard and its marker, the
 * onboarding meta row), so the same contract is checked on both SQLite and Postgres runs.
 *
 * The pg-only block asserts what only the Postgres path can prove: the full 24-table schema comes
 * up from `bootstrapPg`, reseeding is idempotent and never reverts user edits, the dashboard
 * marker keeps a deleted dashboard deleted, and `skipOwnerBootstrap` creates no user.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { join, resolve } from 'path';
import { dbKind } from '@/lib/db/backend';
import { db, dbReady, pgDb, rawSqlite } from '@/lib/db/client';
import { runSeeds } from '@/lib/db/migrate';
import { seedPg } from '@/lib/db/pg/seeds';

// Anchored to this file's location, not process.cwd(): under 'npm test' from the repo root the
// workers' cwd is the root, where data/packs does not exist, and seedPackRules would silently
// no-op. Same trap demo-generator.test.ts documents.
const DATA_DIR = join(resolve(__dirname, '..', '..'), 'data');

/** Runs raw SQL against whichever backend the suite selected, normalized to plain row objects. */
async function rows(q: string): Promise<Record<string, unknown>[]> {
  await dbReady;
  if (dbKind === 'pg') {
    const res = await pgDb!.execute(sql.raw(q));
    return res.rows as Record<string, unknown>[];
  }
  return db.all(sql.raw(q));
}

/** COUNT(*) helper: node-postgres returns bigint counts as strings, SQLite as numbers. */
async function countOf(q: string): Promise<number> {
  const [row] = await rows(q);
  return Number(row!.n);
}

beforeAll(async () => {
  await dbReady;
  // On the SQLite run every test file in a worker shares one database, so an earlier file may
  // have cleared rules or deleted dashboards. Reseed to the fresh-install baseline this file
  // asserts; that reseed IS the contract under test. Reseeding respects the dashboards marker,
  // so drop the marker first if the default dashboard is gone.
  const dash = await rows(`SELECT id FROM dashboards WHERE id = 'default'`);
  if (dash.length === 0) {
    if (dbKind === 'pg') {
      await pgDb!.execute(sql.raw(`DELETE FROM meta WHERE key = 'dashboards-seeded-v1'`));
    } else {
      rawSqlite!.exec(`DELETE FROM meta WHERE key = 'dashboards-seeded-v1'`);
    }
  }
  if (dbKind === 'pg') {
    await seedPg(pgDb!, DATA_DIR, { skipOwnerBootstrap: true });
  } else {
    runSeeds(rawSqlite!, DATA_DIR, { skipOwnerBootstrap: true });
  }
});

describe('seeded baseline (both backends)', () => {
  it('built-in and pack rules are present', async () => {
    expect(await countOf(`SELECT COUNT(*) AS n FROM rules WHERE type = 'builtin'`)).toBeGreaterThan(0);
    expect(await countOf(`SELECT COUNT(*) AS n FROM rules WHERE pack = 'aprl-v2'`)).toBeGreaterThan(0);
  });

  it('the five built-in categories exist in order', async () => {
    const cats = await rows(`SELECT id FROM categories ORDER BY sort_order`);
    expect(cats.map(c => c.id)).toEqual(['compliance', 'cost', 'security', 'identity', 'reliability']);
  });

  it('the starter dashboard and its marker exist', async () => {
    const dash = await rows(`SELECT id FROM dashboards WHERE id = 'default'`);
    expect(dash).toHaveLength(1);
    const marker = await rows(`SELECT value FROM meta WHERE key = 'dashboards-seeded-v1'`);
    expect(marker).toHaveLength(1);
  });

  it('onboarding state was seeded', async () => {
    const [row] = await rows(`SELECT value FROM meta WHERE key = 'onboarding-v1'`);
    expect(row).toBeDefined();
    const state = JSON.parse(row!.value as string) as { status: string };
    expect(['pending', 'skipped']).toContain(state.status);
  });
});

describe.runIf(process.env.RULEBEAT_TEST_PG_URL)('postgres bootstrap and reseed', () => {
  it('bootstrapPg created the full schema', async () => {
    const tables = (await rows(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    )).map(r => r.table_name);
    const expected = [
      'rules', 'scans', 'suppressions', 'schema_cache', 'resource_types_cache', 'dashboards',
      'categories', 'schedules', 'meta', 'users', 'azure_credentials', 'log_analytics_workspaces',
      'local_accounts', 'sso_providers', 'audit_log', 'findings', 'finding_events',
      'posture_snapshots', 'notification_channels', 'schedule_notification_channels',
      'schedule_runs', 'notification_deliveries', 'saved_queries', 'query_runs',
    ];
    for (const t of expected) expect(tables).toContain(t);
  });

  it('reseeding is idempotent and never reverts user edits', async () => {
    // A user's category label/colour edit and a disabled builtin rule must survive a reseed
    // (which is what every app restart does).
    await pgDb!.execute(sql.raw(
      `UPDATE categories SET label = 'My Cost', color = '#123456' WHERE id = 'cost'`,
    ));
    const [rule] = await rows(`SELECT id FROM rules WHERE type = 'builtin' LIMIT 1`);
    const ruleId = rule!.id as string;
    await pgDb!.execute(sql.raw(`UPDATE rules SET enabled = FALSE WHERE id = '${ruleId}'`));
    // Deliberately break what the seed IS allowed to re-assert.
    await pgDb!.execute(sql.raw(`UPDATE categories SET sort_order = 99 WHERE id = 'cost'`));

    await seedPg(pgDb!, DATA_DIR, { skipOwnerBootstrap: true });

    const [cost] = await rows(`SELECT label, color, sort_order FROM categories WHERE id = 'cost'`);
    expect(cost!.label).toBe('My Cost');       // user edit kept
    expect(cost!.color).toBe('#123456');       // user edit kept
    expect(Number(cost!.sort_order)).toBe(2);  // structural field re-asserted
    const [ruleAfter] = await rows(`SELECT enabled FROM rules WHERE id = '${ruleId}'`);
    expect(ruleAfter!.enabled).toBe(false);    // disable kept
  });

  it('the dashboards marker keeps a deleted dashboard deleted', async () => {
    await pgDb!.execute(sql.raw(`DELETE FROM dashboards`));
    await seedPg(pgDb!, DATA_DIR, { skipOwnerBootstrap: true });
    expect(await countOf(`SELECT COUNT(*) AS n FROM dashboards`)).toBe(0);
  });

  it('skipOwnerBootstrap creates no user', async () => {
    // tests/setup.ts drops and recreates the schema per file, and the client seeds with
    // skipOwnerBootstrap under VITEST, so a user row here would mean the flag leaked.
    expect(await countOf(`SELECT COUNT(*) AS n FROM users`)).toBe(0);
  });
});
