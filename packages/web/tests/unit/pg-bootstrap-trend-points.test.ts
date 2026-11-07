/**
 * Trust in dashboard numbers (map #320): a Postgres database bootstrapped before
 * `posture_snapshots.finding_count_version` existed gains the column on the next boot, keeps every
 * column of every trend point it held, and reads each as version 0, "not recorded". The table has
 * shipped, so the CREATE TABLE alone would leave an existing database without the column. The fixture
 * (tests/fixtures/trend-points.ts) is shared with the SQLite twin, and later tickets add assertions to
 * it. Postgres only by nature; skipped on the default SQLite run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { dbKind } from '@/lib/db/backend';
import { dbReady, pgDb } from '@/lib/db/client';
import { bootstrapPg } from '@/lib/db/pg/bootstrap';
import { resetDb } from '../helpers/db';
import { TREND_POINT_COLUMNS, TREND_RULES, byPointKey, isPreToday, trendPoints } from '../fixtures/trend-points';

const literal = (value: string | number | null): string =>
  value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${value.replace(/'/g, "''")}'`;

const rows = async (text: string) => (await pgDb!.execute(sql.raw(text))).rows as Record<string, unknown>[];
const points = async () => (await rows('SELECT * FROM posture_snapshots')).sort(byPointKey);
const ruleIds = TREND_RULES.map(r => literal(r.id)).join(', ');
const rulesOf = () => rows(`SELECT * FROM rules WHERE id IN (${ruleIds}) ORDER BY id`);

describe.skipIf(dbKind !== 'pg')('bootstrapPg adds finding_count_version to an existing posture_snapshots (map #320)', () => {
  afterEach(async () => { await resetDb(); });

  it('keeps every column of every point dated before today, and reads each as version 0', async () => {
    await dbReady;
    await resetDb();
    await bootstrapPg(pgDb!);
    await pgDb!.execute(sql.raw('ALTER TABLE posture_snapshots DROP COLUMN finding_count_version'));
    for (const p of trendPoints()) {
      await pgDb!.execute(sql.raw(
        `INSERT INTO posture_snapshots (${TREND_POINT_COLUMNS.join(', ')}) VALUES (${TREND_POINT_COLUMNS.map(c => literal(p[c])).join(', ')})`,
      ));
    }
    for (const r of TREND_RULES) {
      await pgDb!.execute(sql.raw(`
        INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, raw_kql, type, last_run_status)
        VALUES (${literal(r.id)}, ${literal(r.name)}, 'test', ${literal(r.category)}, 'medium', true, '{"level":"subscription"}', '[]', '[]',
          'resources | project id, name, type, location, resourceGroup, subscriptionId', 'custom', ${literal(r.last_run_status)})
      `));
    }
    const before = await points();
    const rulesBefore = await rulesOf();
    expect(before).toHaveLength(trendPoints().length);
    expect(rulesBefore).toHaveLength(TREND_RULES.length);

    await bootstrapPg(pgDb!);

    const after = await points();
    expect(after).toHaveLength(before.length);
    expect(after.filter(isPreToday)).toEqual(before.filter(isPreToday).map(p => ({ ...p, finding_count_version: 0 })));
    expect(after.map(p => p.finding_count_version)).toEqual(after.map(() => 0));
    expect(await rulesOf()).toEqual(rulesBefore);
  });
});
