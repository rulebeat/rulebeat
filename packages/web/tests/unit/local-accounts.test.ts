import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser, deleteUser, type AppUser } from '@/lib/db/users';
import {
  clearFailedAttempts, clearPassword, countAdminsWithPassword, getLocalAccount,
  isLockedOut, listUserIdsWithPassword, recordFailedAttempt, setPassword,
} from '@/lib/db/local-accounts';

function makeUser(email: string, role: AppUser['role'] = 'viewer'): AppUser {
  const result = createUser({ email, role });
  if ('error' in result) throw new Error(result.error);
  return result.user;
}

beforeEach(() => {
  resetDb();
});

describe('setPassword / getLocalAccount', () => {
  it('creates a local account with the requested mustChangePassword flag', () => {
    const user = makeUser('owner@example.com', 'admin');
    setPassword(user.id, 'irrelevant-hash', { mustChangePassword: true });

    const account = getLocalAccount(user.id);
    expect(account?.mustChangePassword).toBe(true);
    expect(account?.failedAttempts).toBe(0);
  });

  it('a self-service change clears the forced flag', () => {
    const user = makeUser('owner2@example.com', 'admin');
    setPassword(user.id, 'temp-hash', { mustChangePassword: true });
    expect(getLocalAccount(user.id)?.mustChangePassword).toBe(true);

    setPassword(user.id, 'chosen-hash', { mustChangePassword: false });
    expect(getLocalAccount(user.id)?.mustChangePassword).toBe(false);
  });

  it('setting a new password clears any prior lockout state', () => {
    const user = makeUser('reset-me@example.com');
    setPassword(user.id, 'hash-1', { mustChangePassword: false });
    for (let i = 0; i < 5; i++) recordFailedAttempt(user.id);
    expect(isLockedOut(getLocalAccount(user.id)!)).toBe(true);

    setPassword(user.id, 'hash-2', { mustChangePassword: true });
    const account = getLocalAccount(user.id)!;
    expect(account.failedAttempts).toBe(0);
    expect(isLockedOut(account)).toBe(false);
  });

  it('getLocalAccount returns null for a user with no local password', () => {
    const user = makeUser('sso-only@example.com');
    expect(getLocalAccount(user.id)).toBeNull();
  });
});

describe('lockout', () => {
  it('does not lock out before the threshold', () => {
    const user = makeUser('almost-locked@example.com');
    setPassword(user.id, 'hash', { mustChangePassword: false });
    for (let i = 0; i < 4; i++) recordFailedAttempt(user.id);
    expect(isLockedOut(getLocalAccount(user.id)!)).toBe(false);
  });

  it('locks out once the failure threshold is reached', () => {
    const user = makeUser('will-be-locked@example.com');
    setPassword(user.id, 'hash', { mustChangePassword: false });
    for (let i = 0; i < 5; i++) recordFailedAttempt(user.id);
    expect(isLockedOut(getLocalAccount(user.id)!)).toBe(true);
  });

  it('isLockedOut treats a future lockedUntil as locked and a past one as expired', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(isLockedOut({ lockedUntil: future })).toBe(true);
    expect(isLockedOut({ lockedUntil: past })).toBe(false);
    expect(isLockedOut({ lockedUntil: null })).toBe(false);
  });

  it('a successful sign-in resets the failure counter', () => {
    const user = makeUser('recovers@example.com');
    setPassword(user.id, 'hash', { mustChangePassword: false });
    recordFailedAttempt(user.id);
    recordFailedAttempt(user.id);
    expect(getLocalAccount(user.id)!.failedAttempts).toBe(2);

    clearFailedAttempts(user.id);
    const account = getLocalAccount(user.id)!;
    expect(account.failedAttempts).toBe(0);
    expect(account.lockedUntil).toBeNull();
  });

  it('recordFailedAttempt is a no-op for a user with no local account', () => {
    const user = makeUser('no-local-account@example.com');
    expect(() => recordFailedAttempt(user.id)).not.toThrow();
    expect(getLocalAccount(user.id)).toBeNull();
  });
});

describe('clearPassword', () => {
  it('removes the local account entirely', () => {
    const user = makeUser('remove-me@example.com');
    setPassword(user.id, 'hash', { mustChangePassword: false });
    expect(getLocalAccount(user.id)).not.toBeNull();

    clearPassword(user.id);
    expect(getLocalAccount(user.id)).toBeNull();
  });
});

describe('deleting a user', () => {
  it('cascades away their local account', () => {
    const user = makeUser('doomed@example.com');
    setPassword(user.id, 'hash', { mustChangePassword: false });
    expect(getLocalAccount(user.id)).not.toBeNull();

    deleteUser(user.id);
    expect(getLocalAccount(user.id)).toBeNull();
  });
});

describe('countAdminsWithPassword / listUserIdsWithPassword', () => {
  it('counts only admins that actually have a local password', () => {
    const admin1 = makeUser('admin1@example.com', 'admin');
    const admin2 = makeUser('admin2@example.com', 'admin');
    makeUser('viewer-with-password@example.com', 'viewer');

    expect(countAdminsWithPassword()).toBe(0);

    setPassword(admin1.id, 'hash', { mustChangePassword: false });
    expect(countAdminsWithPassword()).toBe(1);

    setPassword(admin2.id, 'hash', { mustChangePassword: false });
    expect(countAdminsWithPassword()).toBe(2);

    clearPassword(admin1.id);
    expect(countAdminsWithPassword()).toBe(1);
  });

  it('a viewer with a local password does not count as an admin with one', () => {
    const viewer = makeUser('just-a-viewer@example.com', 'viewer');
    setPassword(viewer.id, 'hash', { mustChangePassword: false });
    expect(countAdminsWithPassword()).toBe(0);
  });

  it('lists exactly the user ids that currently have a local password', () => {
    const withPw = makeUser('has-password@example.com');
    const withoutPw = makeUser('no-password@example.com');
    setPassword(withPw.id, 'hash', { mustChangePassword: false });

    const ids = listUserIdsWithPassword();
    expect(ids).toContain(withPw.id);
    expect(ids).not.toContain(withoutPw.id);
  });
});
