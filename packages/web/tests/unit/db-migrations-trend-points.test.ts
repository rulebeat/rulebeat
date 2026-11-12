/**
 * Trust in dashboard numbers (map #320): the upgrade that adds `posture_snapshots.finding_count_version`.
 * The column is additive. Every trend point an install already holds keeps every column it had, and
 * reads as version 0, "not recorded". Migrations swallow their own errors, so this reads every column
 * of every point back rather than trusting that nothing threw. The fixture (tests/fixtures/trend-points.ts)
 * is shared with the Postgres twin, and later tickets add assertions to it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { makeSample, open } from '../fixtures/upgrade';
import { runMigrations } from '@/lib/db/migrate';
import {
  DELETED_CATEGORY, SUB_LOWER, TREND_POINT_COLUMNS, TREND_RULES, TREND_TREE, byPointKey, daysAgo, isPreToday, levelKey, trendPoints,
} from '../fixtures/trend-points';

let sqlite: Database.Database | undefined;
let closeProductDb: (() => void) | undefined;
afterEach(() => {
  sqlite?.close();
  sqlite = undefined;
  closeProductDb?.();
  closeProductDb = undefined;
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Starts the product against `file`, as the running app does: the real startup migrations run on import. */
async function startProductOn(file: string) {
  vi.resetModules();
  vi.stubEnv('RULEBEAT_DATABASE_URL', '');
  vi.stubEnv('RULEBEAT_DATABASE_URL_FILE', '');
  vi.stubEnv('RULEBEAT_DB_PATH', file);
  const client = await import('@/lib/db/client');
  closeProductDb = () => client.rawSqlite?.close();
}

const all = (db: Database.Database, text: string, ...params: unknown[]) => db.prepare(text).all(...params) as Record<string, unknown>[];
const columns = (db: Database.Database, table: string) => all(db, `PRAGMA table_info(${table})`).map(c => c.name);
const points = (db: Database.Database) => all(db, `SELECT * FROM posture_snapshots`).sort(byPointKey);
const ruleIds = TREND_RULES.map(r => r.id);
const rulesOf = (db: Database.Database) => all(db, `SELECT * FROM rules WHERE id IN (${ruleIds.map(() => '?').join(',')}) ORDER BY id`, ...ruleIds);

/** A database exactly as the release before finding_count_version left it, holding the shared trend points and rules. */
function previousReleaseDatabase() {
  const sample = makeSample('current');
  const db = open(sample.file);
  runMigrations(db);
  db.exec(`ALTER TABLE posture_snapshots DROP COLUMN finding_count_version`);
  const insertPoint = db.prepare(`INSERT INTO posture_snapshots (${TREND_POINT_COLUMNS.join(', ')}) VALUES (${TREND_POINT_COLUMNS.map(c => `@${c}`).join(', ')})`);
  for (const p of trendPoints()) insertPoint.run(p);
  const insertRule = db.prepare(`
    INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, raw_kql, type, last_run_status)
    VALUES (@id, @name, 'test', @category, 'medium', 1, '{"level":"subscription"}', '[]', '[]',
      'resources | project id, name, type, location, resourceGroup, subscriptionId', 'custom', @last_run_status)
  `);
  for (const r of TREND_RULES) insertRule.run(r);
  const insertNode = db.prepare(`INSERT INTO management_group_hierarchy (tenant_id, kind, node_id, display_name, parent_id) VALUES (@tenant_id, @kind, @node_id, @display_name, @parent_id)`);
  for (const n of TREND_TREE) insertNode.run(n);
  return { sample, db };
}

describe('upgrading to a database that records a finding count version on every trend point', () => {
  it('keeps every column of every point dated before today, adds none, and removes only what retention removes', async () => {
    const { sample, db } = previousReleaseDatabase();
    expect(columns(db, 'posture_snapshots')).not.toContain('finding_count_version');
    const before = points(db);
    const rulesBefore = rulesOf(db);
    expect(before).toHaveLength(trendPoints().length);
    expect(rulesBefore).toHaveLength(TREND_RULES.length);
    db.close();

    // The first start, as instrumentation.ts runs it: the upgrade, then the refresh of today's points.
    await startProductOn(sample.file);
    await (await import('@/lib/db/snapshots')).backfillSnapshots();

    sqlite = open(sample.file);
    expect(columns(sqlite, 'posture_snapshots')).toContain('finding_count_version');
    const after = points(sqlite);
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
    // No finding, and every rule here is unscoped, so the subscription is graded by the rules the install is.
    const install = today.find(p => p.subscription_id === '')!;
    expect(today.find(p => p.subscription_id === SUB_LOWER)).toMatchObject({ total_rules: install.total_rules, active_findings: 0 });
    expect(install.total_rules).toBeGreaterThan(0);
    expect(rulesOf(sqlite)).toEqual(rulesBefore);
  });
});
