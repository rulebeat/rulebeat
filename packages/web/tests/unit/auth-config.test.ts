/**
 * The proxy runs on every request against `auth.config.ts` alone (no database); `auth.ts` builds
 * the full config the actual sign-in routes use. This suite exists because the two silently
 * drifting apart has a specific, nasty failure mode: a secret mismatch between them doesn't throw
 * anywhere — it just makes every session the full config issues look invalid to the proxy, so
 * every request loops back to /signin while sign-in itself appears to work fine.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authConfig } from '@/auth.config';
import { buildAuthConfig } from '@/auth';
import { resetDb } from '../helpers/db';
import { createUser, bumpSessionEpoch, type AppUser } from '@/lib/db/users';

/**
 * A real bug caught only by manually running the dev server, not by any test above: `lib/auth-
 * secret.ts` read `process.env[SECRET_ENV]` (a variable-indexed lookup) instead of the literal
 * `process.env.AUTH_SECRET`. Next's bundler only inlines env vars it can see referenced statically
 * for the edge/proxy build, so the *proxy's* copy of `getAuthSecret()` silently saw `undefined`
 * and generated (and cached) its own random key file — completely different from the one the
 * Node-runtime route handlers use. Nothing threw; every session the app minted just failed to
 * authorize at the proxy, redirecting every request back to /signin. Vitest runs both configs in
 * the same plain Node process, so it can't reproduce the split bundling that caused this — the
 * only thing it CAN do is ban the pattern that caused it, statically, the same way the credential
 * and password chokepoint tests do.
 */
describe('auth-secret.ts reads AUTH_SECRET the way the edge/proxy bundler can see', () => {
  it('uses a static `process.env.AUTH_SECRET`, never a dynamic `process.env[...]` lookup', () => {
    const path = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'auth-secret.ts');
    const source = readFileSync(path, 'utf8');
    expect(source).toMatch(/process\.env\.AUTH_SECRET/);
    expect(source).not.toMatch(/process\.env\[\s*(['"`]AUTH_SECRET['"`]|SECRET_ENV)\s*\]/);
  });

  // spec 023: AUTH_SECRET_FILE is read by the same module, so it needs the identical guarantee —
  // a dynamic lookup here would silently resolve to `undefined` in the edge bundle exactly like
  // the original AUTH_SECRET bug, just for the file variant instead.
  it('uses a static `process.env.AUTH_SECRET_FILE`, never a dynamic `process.env[...]` lookup', () => {
    const path = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'auth-secret.ts');
    const source = readFileSync(path, 'utf8');
    expect(source).toMatch(/process\.env\.AUTH_SECRET_FILE/);
    expect(source).not.toMatch(/process\.env\[\s*(['"`]AUTH_SECRET_FILE['"`]|SECRET_ENV)\s*\]/);
  });
});

describe('auth.config.ts (the DB-free half used by the proxy)', () => {
  it('pages.signIn and pages.error both point at /signin', () => {
    expect(authConfig.pages?.signIn).toBe('/signin');
    expect(authConfig.pages?.error).toBe('/signin');
  });

  it('trustHost is explicitly true', () => {
    expect(authConfig.trustHost).toBe(true);
  });

  it('has no providers of its own', () => {
    expect(authConfig.providers).toEqual([]);
  });

  describe('callbacks.authorized', () => {
    const authorized = authConfig.callbacks!.authorized!;
    // The real signature is `({ request, auth }) => ...`; every case here only needs `auth`.
    const call = (auth: unknown) => authorized({ auth } as never);

    it('is false with no session at all', () => {
      expect(call(undefined)).toBe(false);
    });

    it('is false for a session with no user', () => {
      expect(call({})).toBe(false);
    });

    it('is false for a user with no uid', () => {
      expect(call({ user: {} })).toBe(false);
    });

    it('is false for a legacy token carrying the old oid claim but no uid', () => {
      expect(call({ user: { oid: 'legacy-entra-oid' } })).toBe(false);
    });

    it('is true once uid is present', () => {
      expect(call({ user: { uid: 'user-row-id' } })).toBe(true);
    });
  });

  describe('callbacks.session', () => {
    it('copies token.uid onto session.user.uid', async () => {
      const session = await authConfig.callbacks!.session!({
        session: { user: {}, expires: '' } as never,
        token: { uid: 'abc-123' } as never,
      } as never);
      expect((session.user as { uid?: string }).uid).toBe('abc-123');
    });

    it('sets uid to null when the token carries none', async () => {
      const session = await authConfig.callbacks!.session!({
        session: { user: {}, expires: '' } as never,
        token: {} as never,
      } as never);
      expect((session.user as { uid?: string | null }).uid).toBeNull();
    });

    it('copies token.epoch onto session.user.epoch', async () => {
      const session = await authConfig.callbacks!.session!({
        session: { user: {}, expires: '' } as never,
        token: { uid: 'abc-123', epoch: 3 } as never,
      } as never);
      expect((session.user as { epoch?: number | null }).epoch).toBe(3);
    });

    it('sets epoch to null when the token carries none (spec 020)', async () => {
      const session = await authConfig.callbacks!.session!({
        session: { user: {}, expires: '' } as never,
        token: { uid: 'abc-123' } as never,
      } as never);
      expect((session.user as { epoch?: number | null }).epoch).toBeNull();
    });
  });
});

describe('auth.ts (the full config auth routes use)', () => {
  // This describe block wants "SSO is fully configured" — set explicitly, not inherited from
  // tests/setup.ts, so the sign-in-config resolution-order tests elsewhere mean something.
  beforeAll(() => {
    process.env.AUTH_MICROSOFT_ENTRA_ID_ID = 'test-client-id';
    process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET = 'test-client-secret';
    process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID = '00000000-0000-0000-0000-000000000001';
  });
  afterAll(() => {
    delete process.env.AUTH_MICROSOFT_ENTRA_ID_ID;
    delete process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET;
    delete process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID;
  });

  it('shares the exact same secret as the proxy config', async () => {
    const full = await buildAuthConfig();
    expect(full.secret).toBe(authConfig.secret);
  });

  it('is built from a function, and resolves at least one provider', async () => {
    const full = await buildAuthConfig();
    expect(Array.isArray(full.providers)).toBe(true);
    expect(full.providers.length).toBeGreaterThanOrEqual(1);
  });

  it('includes both the Entra and local-account (Credentials) providers', async () => {
    const full = await buildAuthConfig();
    const ids = full.providers.map(p => (p as { id?: string }).id ?? (p as { type?: string }).type);
    expect(ids).toContain('microsoft-entra-id');
    expect(ids).toContain('credentials');
  });

  it('spreads the shared pages/trustHost/authorized/session config, not a fork of it', async () => {
    const full = await buildAuthConfig();
    expect(full.pages).toEqual(authConfig.pages);
    expect(full.trustHost).toBe(true);
    expect(full.callbacks!.authorized).toBe(authConfig.callbacks!.authorized);
  });

  describe('callbacks.jwt (spec 020 — stamps the session-epoch claim)', () => {
    function makeUser(email: string): AppUser {
      const result = createUser({ email, role: 'viewer' });
      if ('error' in result) throw new Error(result.error);
      return result.user;
    }

    beforeAll(() => { resetDb(); });

    it('stamps token.epoch from a fresh DB read on initial sign-in', async () => {
      const user = makeUser('jwt-epoch@example.com');
      const full = await buildAuthConfig();
      const token = await full.callbacks!.jwt!({
        token: {},
        user: { id: user.id },
        account: { provider: 'credentials' },
      } as never);
      expect((token as { epoch?: number }).epoch).toBe(0);
    });

    it('reflects a bump that happened before this sign-in', async () => {
      const user = makeUser('jwt-epoch-bumped@example.com');
      bumpSessionEpoch(user.id);
      const full = await buildAuthConfig();
      const token = await full.callbacks!.jwt!({
        token: {},
        user: { id: user.id },
        account: { provider: 'credentials' },
      } as never);
      expect((token as { epoch?: number }).epoch).toBe(1);
    });

    it('leaves an existing token untouched on a session read (no user/account present)', async () => {
      const full = await buildAuthConfig();
      const token = await full.callbacks!.jwt!({
        token: { uid: 'existing', epoch: 5 },
        user: undefined,
        account: null,
      } as never);
      expect((token as { epoch?: number }).epoch).toBe(5);
    });
  });
});
