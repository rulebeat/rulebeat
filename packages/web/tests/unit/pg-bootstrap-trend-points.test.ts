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
import {
  DELETED_CATEGORY, SUB_LOWER, TREND_POINT_COLUMNS, TREND_RULES, TREND_TREE, byPointKey, daysAgo, isPreToday, levelKey, trendPoints,
} from '../fixtures/trend-points';
import { backfillSnapshots } from '@/lib/db/snapshots';

const literal = (value: string | number | null): string =>
  value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${value.replace(/'/g, "''")}'`;

const rows = async (text: string) => (await pgDb!.execute(sql.raw(text))).rows as Record<string, unknown>[];
const points = async () => (await rows('SELECT * FROM posture_snapshots')).sort(byPointKey);
const ruleIds = TREND_RULES.map(r => literal(r.id)).join(', ');
const rulesOf = () => rows(`SELECT * FROM rules WHERE id IN (${ruleIds}) ORDER BY id`);

describe.skipIf(dbKind !== 'pg')('bootstrapPg adds finding_count_version to an existing posture_snapshots (map #320)', () => {
  afterEach(async () => { await resetDb(); });

  it('keeps every column of every point dated before today, adds none, and removes only what retention removes', async () => {
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
    for (const n of TREND_TREE) {
      await pgDb!.execute(sql.raw(
        `INSERT INTO management_group_hierarchy (tenant_id, kind, node_id, display_name, parent_id) VALUES (${literal(n.tenant_id)}, ${literal(n.kind)}, ${literal(n.node_id)}, ${literal(n.display_name)}, ${literal(n.parent_id)})`,
      ));
    }
    const before = await points();
    const rulesBefore = await rulesOf();
    expect(before).toHaveLength(trendPoints().length);
    expect(rulesBefore).toHaveLength(TREND_RULES.length);

    // The next start: the bootstrap adds the column, then the refresh of today's points runs.
    await bootstrapPg(pgDb!);
    await backfillSnapshots();

    const after = await points();
    const past = after.filter(isPreToday);

    // Retention removes the 370-day point (a 366-day one stands in for the baseline at the edge) and the
    // deleted category's point; every other point before today is as it was, now reading version 0.
    const removed = before.filter(isPreToday).filter(p => p.date === daysAgo(370) || p.category === DELETED_CATEGORY);
    expect(removed).toHaveLength(2);
    expect(past).toEqual(before.filter(isPreToday).filter(p => !removed.includes(p)).map(p => ({ ...p, finding_count_version: 0 })));
    // Nothing dated before today was added.
    const keysBefore = new Set(before.map(levelKey));
    expect(past.filter(p => !keysBefore.has(levelKey(p)))).toEqual([]);

    // Today: the install, the subscription (no finding, no rule names it) and the Directory, each as version 1.
    const today = after.filter(p => !isPreToday(p) && p.category === 'security');
    expect(today.map(p => p.subscription_id).sort()).toEqual(['', SUB_LOWER, 'directory']);
    expect(today.map(p => p.finding_count_version)).toEqual(today.map(() => 1));
    expect(await rulesOf()).toEqual(rulesBefore);
  });
});
