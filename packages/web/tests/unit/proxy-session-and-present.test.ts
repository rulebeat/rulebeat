/**
 * Two proxy behaviours a wall screen relies on, both driven through the real default export the
 * way Next does (a NextRequest in, a response out) with the real Auth.js guard behind it.
 *
 * Present (`/dashboards/<id>/present`) must never become link-only access: it is not on the
 * public list, so a signed-out request is sent to /signin. And a screen that is left open for
 * days stays signed in only if the proxy renews a sliding session: a valid token older than
 * `updateAge` has to come back with a fresh session cookie on the pass-through response.
 */
import { NextRequest } from 'next/server';
import type { NextFetchEvent } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decode, encode } from 'next-auth/jwt';
import proxy from '@/proxy';
import { authConfig } from '@/auth.config';
import { getAuthSecret } from '@/lib/auth-secret';

const event = {} as NextFetchEvent;
const ORIGIN = 'http://localhost:3000';
// Over http Auth.js names the cookie without the `__Secure-` prefix. The name is also the salt.
const SESSION_COOKIE = 'authjs.session-token';
const HOUR_MS = 60 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

describe('proxy: Present is guarded', () => {
  it('sends a signed-out request for a dashboard Present page to /signin with a same-origin callbackUrl', async () => {
    const path = '/dashboards/6f1d2c3e-0000-4000-8000-000000000000/present';
    const res = await proxy(new NextRequest(`${ORIGIN}${path}`), event);

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe('/signin');
    const callback = new URL(location.searchParams.get('callbackUrl')!);
    expect(callback.origin).toBe(ORIGIN);
    expect(callback.pathname).toBe(path);
  });
});

describe('proxy: a sliding session is renewed', () => {
  async function tokenIssuedHoursAgo(hours: number): Promise<string> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() - hours * HOUR_MS);
    try {
      return await encode({
        token: { uid: 'user-1', epoch: 1 },
        secret: getAuthSecret(),
        salt: SESSION_COOKIE,
        maxAge: authConfig.session!.maxAge,
      });
    } finally {
      vi.useRealTimers();
    }
  }

  function renewedSessionCookie(res: Response): string | undefined {
    return res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  }

  // next-auth@5.0.0-beta.31 does renew here: for a JWT session, @auth/core's session action
  // re-signs the token with a fresh expiry on every session read, and handleAuth copies that
  // Set-Cookie onto the pass-through response. `updateAge` is only consulted for database sessions.
  // So this is a plain passing test, not `it.fails()`, and a Present tick needs no extra
  // /api/auth/session call to stay signed in.
  it('re-issues the session cookie for a token older than updateAge on a guarded API route', async () => {
    const updateAge = authConfig.session!.updateAge!;
    expect(updateAge).toBe(60 * 60);

    const old = await tokenIssuedHoursAgo(2);
    const res = await proxy(
      new NextRequest(`${ORIGIN}/api/rules`, { headers: { cookie: `${SESSION_COOKIE}=${old}` } }),
      event,
    );

    // The request passed the guard (no redirect to /signin) ...
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1');

    // ... and carries a new session token whose expiry has slid forward.
    const cookie = renewedSessionCookie(res);
    expect(cookie).toBeDefined();
    const renewed = cookie!.split(';')[0].slice(SESSION_COOKIE.length + 1);
    expect(renewed).not.toBe(old);
    const before = await decode({ token: old, secret: getAuthSecret(), salt: SESSION_COOKIE });
    const after = await decode({ token: renewed, secret: getAuthSecret(), salt: SESSION_COOKIE });
    expect(after!.uid).toBe('user-1');
    expect(after!.exp as number).toBeGreaterThan(before!.exp as number);
  });
});
