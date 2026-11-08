/**
 * On Postgres (READ COMMITTED) a check-then-write needs the dashboard advisory lock. Every writer that reads
 * whether a dashboard is the Install default, or whether it can be someone's My default, and then changes it must take the same lock as
 * `chooseInstallDefault()`, or a delete can read the flag as unset while a choice commits and then remove the
 * new Install default with no refusal and no audit. SQLite serialises writers, so the race cannot be driven
 * there; this records which key each writer locks on, before its first read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createDashboard, shareDashboard, chooseInstallDefault, unshareDashboard, deleteDashboardAs } from '@/lib/db/dashboards';
import { setMyDefault } from '@/lib/db/default-dashboard';
import { createUser } from '@/lib/db/users';
import type { DashboardConfig } from '@/lib/types';

const events: string[] = [];

vi.mock('@/lib/db/exec', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/db/exec')>();
  return {
    ...original,
    pgAdvisoryXactLock: async (tx: Parameters<typeof original.pgAdvisoryXactLock>[0], key: number) => {
      events.push(`lock:${key}`);
      return original.pgAdvisoryXactLock(tx, key);
    },
    one: ((query: unknown) => {
      events.push('read');
      return original.one(query as never);
    }) as typeof original.one,
  };
});

const config = { widgets: [] } as unknown as DashboardConfig;

async function sharedDashboard(owner: string, name: string): Promise<string> {
  const made = await createDashboard({ name, config }, owner);
  if (!made.ok) throw new Error(made.reason);
  const shared = await shareDashboard(made.dashboard.id);
  if (!shared.ok) throw new Error(shared.reason);
  return made.dashboard.id;
}

async function lockKeyOf(run: () => Promise<unknown>): Promise<string> {
  events.length = 0;
  await run();
  const first = events.findIndex(e => e.startsWith('lock:') || e === 'read');
  expect(events[first], `the first thing it did was ${events[first]}`).toMatch(/^lock:/);
  return events[first];
}

describe('the dashboards that read the Install default flag or a My default and then write', () => {
  beforeEach(async () => { await resetDb(); events.length = 0; });

  it('lock on the same key as choosing the Install default, before their first read', async () => {
    const made = await createUser({ email: 'owner@example.com', role: 'admin' });
    if ('error' in made) throw new Error(made.error);
    const owner = made.user.id;
    const a = await sharedDashboard(owner, 'A');
    const b = await sharedDashboard(owner, 'B');
    const c = await sharedDashboard(owner, 'C');
    const d = await sharedDashboard(owner, 'D');

    const choose = await lockKeyOf(() => chooseInstallDefault(a));
    const unshare = await lockKeyOf(() => unshareDashboard(b, owner, true));
    const remove = await lockKeyOf(() => deleteDashboardAs(c, true));

    const mine = await lockKeyOf(() => setMyDefault(owner, d));

    expect(mine).toBe(choose);
    expect(unshare).toBe(choose);
    expect(remove).toBe(choose);
  });
});
