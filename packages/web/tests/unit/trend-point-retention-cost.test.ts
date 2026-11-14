/**
 * ADR 0013: retention runs after every queued refresh, including the empty one the scheduler makes every
 * 30 seconds, so its cost must not grow with the history an install keeps. Once an install is a year old each
 * level holds one point past the cutoff, so the statement meets work on every tick for good. This seeds a
 * year of daily points for many subscriptions and times the real refresh, which deletes nothing.
 * Runs on both backends.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db/client';
import { run } from '@/lib/db/exec';
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

    const start = performance.now();
    await refreshSnapshotsFor([]);
    const elapsed = performance.now() - start;

    // The same statement took 5 s or more at this size when it searched the whole category for each old point.
    expect(elapsed).toBeLessThan(1500);
  }, 120_000);
});
