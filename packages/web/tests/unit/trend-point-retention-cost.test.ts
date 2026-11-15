/**
 * ADR 0013: retention runs after every queued refresh, including the empty one the scheduler makes every
 * 30 seconds, so its cost must not grow with the history an install keeps. Once an install is a year old each
 * level holds one point past the cutoff, so the statement meets work on every tick for good. This seeds a
 * year of daily points for many subscriptions and times the real refresh, which deletes nothing.
 * Runs on both backends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db/client';
import { dbKind } from '@/lib/db/backend';
import { many, run } from '@/lib/db/exec';
import { postureSnapshots } from '@/lib/db/tables';
import { listCategories } from '@/lib/db/categories';
import { refreshSnapshotsFor } from '@/lib/db/snapshots';
import { clearRules, execRaw, resetDb } from '../helpers/db';

const DAY_MS = 86_400_000;
const SUBSCRIPTIONS = 150;
const DAYS = 366;

beforeEach(async () => {
  await resetDb();
  await clearRules();
  await execRaw('DELETE FROM posture_snapshots');
});

afterEach(() => vi.restoreAllMocks());

async function countPoints(): Promise<number> {
  return (await many(db.select({ date: postureSnapshots.date }).from(postureSnapshots))).length;
}

/** The writer catches and logs a failed retention, so a statement that throws (a missing index) would still be fast.
 *  The refresh counts as having run retention only when nothing was logged and every point is still there. */
async function timedEmptyRefresh(): Promise<{ elapsed: number; logged: unknown[][] }> {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const start = performance.now();
  await refreshSnapshotsFor([]);
  const elapsed = performance.now() - start;
  return { elapsed, logged: logged.mock.calls };
}

describe('retention cost', () => {
  it('does not scan a category for every point past the cutoff', async () => {
    const categories = (await listCategories()).slice(0, 3).map(c => c.id);
    expect(categories).toHaveLength(3);
    const now = Date.now();
    const rows: (typeof postureSnapshots.$inferInsert)[] = [];
    for (const category of categories) {
      for (let s = 0; s < SUBSCRIPTIONS; s += 1) {
        const level = `00000000-0000-4000-8000-${String(s).padStart(12, '0')}`;
        for (let d = 1; d <= DAYS; d += 1) {
          const date = new Date(now - d * DAY_MS).toISOString().slice(0, 10);
          rows.push({
            category, subscriptionId: level, date, posturePct: 50, passingRules: 1, totalRules: 2,
            formulaVersion: 3, findingCountVersion: 1, activeFindings: 1, updatedAt: `${date}T12:00:00.000Z`,
          });
        }
      }
    }
    for (let i = 0; i < rows.length; i += 500) await run(db.insert(postureSnapshots).values(rows.slice(i, i + 500)));
    if (dbKind === 'pg') await execRaw('ANALYZE posture_snapshots');
    const before = await countPoints();
    expect(before).toBe(categories.length * SUBSCRIPTIONS * DAYS);

    const { elapsed, logged } = await timedEmptyRefresh();

    // Each level's day-366 point is the newest one past the cutoff and is kept, so nothing is deleted.
    expect(logged).toEqual([]);
    expect(await countPoints()).toBe(before);
    // The same statement took 5 s or more at this size when it searched the whole category for each old point.
    expect(elapsed).toBeLessThan(1500);
  }, 120_000);
});

describe('retention cost at the size the product states', () => {
  // 3 categories x 2,000 levels x 366 days is 2.2M points, the dense history an install a year old can hold
  // (30 categories x 2,000 subscriptions would be 22M). Retention keeps each level's newest point past the
  // cutoff and deletes nothing here, so the statement must find that out from the few points past the cutoff
  // and not by reading every point of the table: on SQLite the planner read all 2.2M through the key (231 ms),
  // about 140 s at 22M, on every 30 second tick.
  it('does not read every stored point when it has nothing to delete', async () => {
    const categories = (await listCategories()).slice(0, 3).map(c => c.id);
    expect(categories).toHaveLength(3);
    const columns = `category, subscription_id, date, posture_pct, passing_rules, total_rules, unknown_rules,
      activity_rule_count, formula_version, finding_count_version, active_findings, severity_counts, updated_at`;
    for (const category of categories) {
      await execRaw(dbKind === 'pg'
        ? `INSERT INTO posture_snapshots (${columns})
           SELECT '${category}', '00000000-0000-4000-8000-' || lpad(l::text, 12, '0'),
                  to_char((now() at time zone 'utc')::date - d, 'YYYY-MM-DD'), 50, 1, 2, 0, 0, 3, 1, 1, '{}',
                  to_char((now() at time zone 'utc')::date - d, 'YYYY-MM-DD') || 'T12:00:00.000Z'
           FROM generate_series(0, 1999) l, generate_series(1, 366) d`
        : `INSERT INTO posture_snapshots (${columns})
           WITH RECURSIVE l(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM l WHERE i < 1999),
                          d(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM d WHERE i < 366)
           SELECT '${category}', '00000000-0000-4000-8000-' || printf('%012d', l.i),
                  date('now', '-' || d.i || ' days'), 50, 1, 2, 0, 0, 3, 1, 1, '{}',
                  date('now', '-' || d.i || ' days') || 'T12:00:00.000Z'
           FROM l, d`);
    }
    if (dbKind === 'pg') await execRaw('ANALYZE posture_snapshots');
    await refreshSnapshotsFor([]);
    const before = await countPoints();
    expect(before).toBe(categories.length * 2000 * 366);

    const { elapsed, logged } = await timedEmptyRefresh();

    expect(logged).toEqual([]);
    expect(await countPoints()).toBe(before);
    expect(elapsed).toBeLessThan(100);
  }, 300_000);
});
