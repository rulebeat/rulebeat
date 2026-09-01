import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser, deleteUser, type AppUser } from '@/lib/db/users';
import {
  clearFailedAttempts, clearPassword, countAdminsWithPassword, getLocalAccount,
  isLockedOut, listUserIdsWithPassword, recordFailedAttempt, setPassword,
} from '@/lib/db/local-accounts';

async function makeUser(email: string, role: AppUser['role'] = 'viewer'): Promise<AppUser> {
  const result = await createUser({ email, role });
  if ('error' in result) throw new Error(result.error);
  return result.user;
}

beforeEach(async () => {
  await resetDb();
});

describe('setPassword / getLocalAccount', () => {
  it('creates a local account with the requested mustChangePassword flag', async () => {
    const user = await makeUser('owner@example.com', 'admin');
    await setPassword(user.id, 'irrelevant-hash', { mustChangePassword: true });

    const account = await getLocalAccount(user.id);
    expect(account?.mustChangePassword).toBe(true);
    expect(account?.failedAttempts).toBe(0);
  });

  it('a self-service change clears the forced flag', async () => {
    const user = await makeUser('owner2@example.com', 'admin');
    await setPassword(user.id, 'temp-hash', { mustChangePassword: true });
    expect((await getLocalAccount(user.id))?.mustChangePassword).toBe(true);

    await setPassword(user.id, 'chosen-hash', { mustChangePassword: false });
    expect((await getLocalAccount(user.id))?.mustChangePassword).toBe(false);
  });

  it('setting a new password clears any prior lockout state', async () => {
    const user = await makeUser('reset-me@example.com');
    await setPassword(user.id, 'hash-1', { mustChangePassword: false });
    for (let i = 0; i < 5; i++) await recordFailedAttempt(user.id);
    expect(isLockedOut((await getLocalAccount(user.id))!)).toBe(true);

    await setPassword(user.id, 'hash-2', { mustChangePassword: true });
    const account = (await getLocalAccount(user.id))!;
    expect(account.failedAttempts).toBe(0);
    expect(isLockedOut(account)).toBe(false);
  });

  it('getLocalAccount returns null for a user with no local password', async () => {
    const user = await makeUser('sso-only@example.com');
    expect(await getLocalAccount(user.id)).toBeNull();
  });
});

describe('lockout', () => {
  it('does not lock out before the threshold', async () => {
    const user = await makeUser('almost-locked@example.com');
    await setPassword(user.id, 'hash', { mustChangePassword: false });
    for (let i = 0; i < 4; i++) await recordFailedAttempt(user.id);
    expect(isLockedOut((await getLocalAccount(user.id))!)).toBe(false);
  });

  it('locks out once the failure threshold is reached', async () => {
    const user = await makeUser('will-be-locked@example.com');
    await setPassword(user.id, 'hash', { mustChangePassword: false });
    for (let i = 0; i < 5; i++) await recordFailedAttempt(user.id);
    expect(isLockedOut((await getLocalAccount(user.id))!)).toBe(true);
  });

  it('isLockedOut treats a future lockedUntil as locked and a past one as expired', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(isLockedOut({ lockedUntil: future })).toBe(true);
    expect(isLockedOut({ lockedUntil: past })).toBe(false);
    expect(isLockedOut({ lockedUntil: null })).toBe(false);
  });

  it('a successful sign-in resets the failure counter', async () => {
    const user = await makeUser('recovers@example.com');
    await setPassword(user.id, 'hash', { mustChangePassword: false });
    await recordFailedAttempt(user.id);
    await recordFailedAttempt(user.id);
    expect((await getLocalAccount(user.id))!.failedAttempts).toBe(2);

    await clearFailedAttempts(user.id);
    const account = (await getLocalAccount(user.id))!;
    expect(account.failedAttempts).toBe(0);
    expect(account.lockedUntil).toBeNull();
  });

  it('recordFailedAttempt is a no-op for a user with no local account', async () => {
    const user = await makeUser('no-local-account@example.com');
    await expect(recordFailedAttempt(user.id)).resolves.toBeUndefined();
    expect(await getLocalAccount(user.id)).toBeNull();
  });
});

describe('clearPassword', () => {
  it('removes the local account entirely', async () => {
    const user = await makeUser('remove-me@example.com');
    await setPassword(user.id, 'hash', { mustChangePassword: false });
    expect(await getLocalAccount(user.id)).not.toBeNull();

    await clearPassword(user.id);
    expect(await getLocalAccount(user.id)).toBeNull();
  });
});

describe('deleting a user', () => {
  it('cascades away their local account', async () => {
    const user = await makeUser('doomed@example.com');
    await setPassword(user.id, 'hash', { mustChangePassword: false });
    expect(await getLocalAccount(user.id)).not.toBeNull();

    await deleteUser(user.id);
    expect(await getLocalAccount(user.id)).toBeNull();
  });
});

describe('countAdminsWithPassword / listUserIdsWithPassword', () => {
  it('counts only admins that actually have a local password', async () => {
    const admin1 = await makeUser('admin1@example.com', 'admin');
    const admin2 = await makeUser('admin2@example.com', 'admin');
    await makeUser('viewer-with-password@example.com', 'viewer');

    expect(await countAdminsWithPassword()).toBe(0);

    await setPassword(admin1.id, 'hash', { mustChangePassword: false });
    expect(await countAdminsWithPassword()).toBe(1);

    await setPassword(admin2.id, 'hash', { mustChangePassword: false });
    expect(await countAdminsWithPassword()).toBe(2);

    await clearPassword(admin1.id);
    expect(await countAdminsWithPassword()).toBe(1);
  });

  it('a viewer with a local password does not count as an admin with one', async () => {
    const viewer = await makeUser('just-a-viewer@example.com', 'viewer');
    await setPassword(viewer.id, 'hash', { mustChangePassword: false });
    expect(await countAdminsWithPassword()).toBe(0);
  });

  it('lists exactly the user ids that currently have a local password', async () => {
    const withPw = await makeUser('has-password@example.com');
    const withoutPw = await makeUser('no-password@example.com');
    await setPassword(withPw.id, 'hash', { mustChangePassword: false });

    const ids = await listUserIdsWithPassword();
    expect(ids).toContain(withPw.id);
    expect(ids).not.toContain(withoutPw.id);
  });
});
