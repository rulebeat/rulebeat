/**
 * The saved-filters write takes the same Postgres advisory lock as every other write to the dashboards
 * table (see lib/db/dashboards.ts). On SQLite the lock is a no-op, and the test Postgres cannot hold two
 * connections at once, so the observable contract here is that the lock is taken before the revision is
 * read, and that two saves from one revision land once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';

const order: string[] = [];
vi.mock('@/lib/db/exec', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db/exec')>('@/lib/db/exec');
  return {
    ...actual,
    pgAdvisoryXactLock: (...args: Parameters<typeof actual.pgAdvisoryXactLock>) => { order.push('lock'); return actual.pgAdvisoryXactLock(...args); },
    one: (...args: Parameters<typeof actual.one>) => { order.push('read'); return actual.one(...args); },
  };
});

const { createDashboard, getDashboard, updateDashboardFilters } = await import('@/lib/db/dashboards');

let id: string;
beforeEach(async () => {
  await resetDb();
  const created = await createDashboard({ name: `lock ${crypto.randomUUID()}`, config: { widgets: [], filters: { subscriptions: ['a'] } } as never });
  if (!created.ok) throw new Error('setup');
  id = created.dashboard.id;
  order.length = 0;
});

describe('updateDashboardFilters', () => {
  it('takes the dashboards write lock before it reads the revision', async () => {
    await updateDashboardFilters(id, 1, { lists: { severities: ['high'] } as never });
    expect(order.indexOf('lock')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('lock')).toBeLessThan(order.indexOf('read'));
  });

  it('lets one of two saves from the same revision land and answers the other as stale', async () => {
    const [first, second] = await Promise.all([
      updateDashboardFilters(id, 1, { lists: { severities: ['high'] } as never }),
      updateDashboardFilters(id, 1, { lists: { severities: ['low'] } as never }),
    ]);
    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    expect((await getDashboard(id))!.revision).toBe(2);
  });
});
