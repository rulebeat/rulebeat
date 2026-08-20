/**
 * Spec 020 — the session-invalidation counter. A local-password mutation (self-service change,
 * admin set/reset/remove) bumps users.sessionEpoch; a JWT stamped with a stale epoch must be
 * treated as signed out even though it still verifies cryptographically.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser, bumpSessionEpoch, getUser, type AppUser } from '@/lib/db/users';

function makeUser(email: string): AppUser {
  const result = createUser({ email, role: 'viewer' });
  if ('error' in result) throw new Error(result.error);
  return result.user;
}

beforeEach(() => {
  resetDb();
});

describe('users.sessionEpoch', () => {
  it('defaults to 0 for a freshly created row', () => {
    const user = makeUser('fresh@example.com');
    expect(user.sessionEpoch).toBe(0);
  });

  it('bumpSessionEpoch increments the stored value', () => {
    const user = makeUser('bump@example.com');
    bumpSessionEpoch(user.id);
    expect(getUser(user.id)!.sessionEpoch).toBe(1);
  });

  it('bumpSessionEpoch is cumulative across repeated calls', () => {
    const user = makeUser('bump2@example.com');
    bumpSessionEpoch(user.id);
    bumpSessionEpoch(user.id);
    bumpSessionEpoch(user.id);
    expect(getUser(user.id)!.sessionEpoch).toBe(3);
  });

  it('only bumps the targeted user, not every row', () => {
    const a = makeUser('a@example.com');
    const b = makeUser('b@example.com');
    bumpSessionEpoch(a.id);
    expect(getUser(a.id)!.sessionEpoch).toBe(1);
    expect(getUser(b.id)!.sessionEpoch).toBe(0);
  });
});

describe('getCurrentUser() epoch enforcement', () => {
  it('a token with no epoch claim matches a fresh row default of 0 (no mass logout on upgrade)', async () => {
    const user = makeUser('legacy-token@example.com');
    const { getCurrentUser } = await loadApiAuth({ user: { uid: user.id } });
    const result = await getCurrentUser();
    expect(result?.id).toBe(user.id);
  });

  it('a token whose epoch matches the current row resolves normally', async () => {
    const user = makeUser('matching@example.com');
    const { getCurrentUser } = await loadApiAuth({ user: { uid: user.id, epoch: 0 } });
    const result = await getCurrentUser();
    expect(result?.id).toBe(user.id);
  });

  it('a token whose epoch is stale (a password mutation happened since) is treated as signed out', async () => {
    const user = makeUser('stale@example.com');
    bumpSessionEpoch(user.id); // row is now at epoch 1; token below still claims 0
    const { getCurrentUser } = await loadApiAuth({ user: { uid: user.id, epoch: 0 } });
    const result = await getCurrentUser();
    expect(result).toBeNull();
  });

  it('a token whose epoch matches after the bump resolves again', async () => {
    const user = makeUser('rebumped@example.com');
    bumpSessionEpoch(user.id);
    const { getCurrentUser } = await loadApiAuth({ user: { uid: user.id, epoch: 1 } });
    const result = await getCurrentUser();
    expect(result?.id).toBe(user.id);
  });
});

/**
 * `lib/api-auth.ts` imports `@/auth` at module scope, so the mock has to be registered via
 * `vi.doMock` + a fresh dynamic import per test rather than the usual top-of-file `vi.mock` — this
 * suite needs a different session value per case, not one fixed for the whole file.
 */
async function loadApiAuth(session: unknown) {
  const { vi } = await import('vitest');
  vi.resetModules();
  vi.doMock('@/auth', () => ({ auth: async () => session }));
  return import('@/lib/api-auth');
}
