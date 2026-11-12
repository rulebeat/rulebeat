/**
 * Postgres runs write transactions at READ COMMITTED, so a check-then-write on the Install default or on
 * someone's My default only holds if every writer takes the dashboard advisory lock first. Each test here
 * keeps one transaction open (its work done, not committed) and starts the other writer meanwhile: the
 * second must wait for the first and then see what it did. Without the lock the second runs at once against
 * the committed state and leaves a My default nobody can open, or an Install default that is gone.
 * Postgres only: SQLite serialises writers, and `dashboard-default-locking.test.ts` covers the lock order there.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { dbKind } from '@/lib/db/backend';
import { dbReady, pgDb } from '@/lib/db/client';
import { inTransaction } from '@/lib/db/exec';
import { resetDb } from '../helpers/db';
import { createDashboard, shareDashboard, chooseInstallDefault, unshareDashboard, deleteDashboardAs, getInstallDefaultId } from '@/lib/db/dashboards';
import { getMyDefault, setMyDefault } from '@/lib/db/default-dashboard';
import { createUser, type AppUser } from '@/lib/db/users';
import type { DashboardConfig } from '@/lib/types';

const config = { widgets: [] } as unknown as DashboardConfig;

async function makeUser(email: string, role: AppUser['role']): Promise<AppUser> {
  const made = await createUser({ email, role });
  if ('error' in made) throw new Error(made.error);
  return made.user;
}

async function sharedDashboard(ownerId: string, name: string): Promise<string> {
  const made = await createDashboard({ name, config }, ownerId);
  if (!made.ok) throw new Error(made.reason);
  const shared = await shareDashboard(made.dashboard.id);
  if (!shared.ok) throw new Error(shared.reason);
  return made.dashboard.id;
}

/** True once some session is waiting on an advisory lock. */
async function someoneWaitsOnALock(): Promise<boolean> {
  const res = await pgDb!.execute(sql.raw(`SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`));
  return Number((res.rows[0] as { n: unknown }).n) > 0;
}

async function waitUntilBlocked(): Promise<void> {
  for (let i = 0; i < 100 && !(await someoneWaitsOnALock()); i++) await new Promise(r => setTimeout(r, 50));
}

/**
 * Runs `held` in a transaction that stays open, starts `contender` on its own connection meanwhile, lets it
 * either settle or block on the lock, then commits `held` and returns what `contender` answered.
 */
async function contendWith<T>(held: () => Promise<unknown>, contender: () => Promise<T>): Promise<T> {
  let release!: () => void;
  let opened!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const isOpen = new Promise<void>(r => { opened = r; });
  const holder = inTransaction(async () => { await held(); opened(); await gate; });
  holder.catch(() => { /* surfaced by the await below */ });
  await isOpen;
  const answer = contender();
  answer.catch(() => { /* surfaced by the await below */ });
  await Promise.race([answer.then(() => undefined, () => undefined), waitUntilBlocked()]);
  release();
  await holder;
  return answer;
}

describe.skipIf(dbKind !== 'pg')('Install default and My default under concurrent writers (Postgres)', () => {
  let owner: AppUser;
  let person: AppUser;

  beforeEach(async () => {
    await dbReady;
    await resetDb();
    owner = await makeUser('race-owner@example.com', 'editor');
    person = await makeUser('race-person@example.com', 'viewer');
  });

  it('choosing My default while its dashboard is being unshared ends with no My default, not one they cannot open', async () => {
    const id = await sharedDashboard(owner.id, 'Shared one');

    const result = await contendWith(
      () => unshareDashboard(id, owner.id, true),
      () => setMyDefault(person.id, id),
    );

    expect(result).toEqual({ ok: false, reason: 'not-found' });
    expect(await getMyDefault(person.id)).toEqual({ dashboardId: null, unavailable: false });
  });

  it('choosing My default while its dashboard is being deleted ends with no My default', async () => {
    const id = await sharedDashboard(owner.id, 'Shared two');

    const result = await contendWith(
      () => deleteDashboardAs(id, true),
      () => setMyDefault(person.id, id),
    );

    expect(result).toEqual({ ok: false, reason: 'not-found' });
    expect(await getMyDefault(person.id)).toEqual({ dashboardId: null, unavailable: false });
  });

  it('choosing the Install default while its dashboard is being deleted leaves the Install default as it was', async () => {
    const id = await sharedDashboard(owner.id, 'Shared three');
    const before = await getInstallDefaultId();

    const result = await contendWith(
      () => deleteDashboardAs(id, true),
      () => chooseInstallDefault(id),
    );

    expect(result).toEqual({ ok: false, reason: 'not-found' });
    expect(await getInstallDefaultId()).toBe(before);
  });

  it('deleting a dashboard while it is being chosen as the Install default is refused, not done unchecked', async () => {
    const id = await sharedDashboard(owner.id, 'Shared four');

    const result = await contendWith(
      () => chooseInstallDefault(id),
      () => deleteDashboardAs(id, false),
    );

    expect(result).toEqual({ ok: false, reason: 'install-default' });
    expect(await getInstallDefaultId()).toBe(id);
  });
});
