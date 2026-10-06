/**
 * The page policy only protects anything if every HTML response carries it and the nonce in it is
 * the one Next stamps on its own scripts. Both depend on proxy.ts wiring, which no other test
 * reaches, so this drives the proxy's default export the way Next does: a NextRequest in, a
 * response out. The real Auth.js guard runs; it needs no database, only the request's cookies.
 *
 * Three things a header-only check would miss are pinned here: `/signin` is public but must still
 * get the policy (the matcher used to exclude it), the guard must still be skipped there, and the
 * nonce must reach the render as request headers (Next reads the nonce off the forwarded
 * Content-Security-Policy request header, not off the response).
 */
import { NextRequest } from 'next/server';
import type { NextFetchEvent } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';
import proxy from '@/proxy';

const event = {} as NextFetchEvent;
const CSP = 'content-security-policy';

function request(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost:3000${path}`, { headers });
}

function nonceOf(response: Response): string {
  const csp = response.headers.get(CSP) ?? '';
  const match = csp.match(/script-src[^;]*'nonce-([^']+)'/);
  if (!match) throw new Error(`no script nonce in: ${csp}`);
  return match[1];
}

/** What Next will hand the render as request headers: the override list plus its values. */
function forwardedRequestHeader(response: Response, name: string): string | null {
  const overridden = (response.headers.get('x-middleware-override-headers') ?? '').split(',');
  return overridden.includes(name) ? response.headers.get(`x-middleware-request-${name}`) : null;
}

afterEach(() => {
  delete process.env.RULEBEAT_CSP;
});

describe('proxy: /signin', () => {
  it('carries a policy with a nonce, though it is outside the auth guard', async () => {
    const response = await proxy(request('/signin'), event);
    expect(nonceOf(response)).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(response.headers.get(CSP)).toContain("frame-ancestors 'none'");
  });

  it('is not redirected, so a signed-out visitor still reaches the page', async () => {
    const response = await proxy(request('/signin?error=AccessDenied'), event);
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('forwards the same nonce to the render, as x-nonce and in the request policy header', async () => {
    const response = await proxy(request('/signin'), event);
    const nonce = nonceOf(response);
    expect(forwardedRequestHeader(response, 'x-nonce')).toBe(nonce);
    expect(forwardedRequestHeader(response, CSP)).toBe(response.headers.get(CSP));
  });

  it('keeps the request headers it was sent (cookies reach the render)', async () => {
    const response = await proxy(request('/signin', { cookie: 'theme=dark' }), event);
    expect(forwardedRequestHeader(response, 'cookie')).toBe('theme=dark');
  });

  it('does not let a client-supplied x-nonce or policy header through', async () => {
    const response = await proxy(
      request('/signin', { 'x-nonce': 'attacker', [CSP]: "script-src 'nonce-attacker'" }),
      event,
    );
    const nonce = nonceOf(response);
    expect(nonce).not.toBe('attacker');
    expect(forwardedRequestHeader(response, 'x-nonce')).toBe(nonce);
    expect(forwardedRequestHeader(response, CSP)).toBe(response.headers.get(CSP));
  });
});

// The matcher no longer excludes /signin, so the guard is skipped in the function instead. Only a
// path other than /signin itself can prove that: the guard never redirects /signin to itself, so
// a signed-out request to /signin would pass either way. These are the paths the old matcher
// excluded by prefix, and a signed-out request must still not be redirected from any of them.
describe('proxy: the paths the old matcher excluded as /signin', () => {
  it.each(['/signin/anything', '/signinx'])('does not run the guard on %s', async (path) => {
    const response = await proxy(request(path), event);
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(nonceOf(response)).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  it.each(['/sign', '/api/rules', '/'])('still runs the guard on %s', async (path) => {
    const response = await proxy(request(path), event);
    expect(response.status).toBe(307);
  });
});

describe('proxy: a guarded page', () => {
  it('still redirects a signed-out request to /signin', async () => {
    const response = await proxy(request('/dashboard'), event);
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location')!).pathname).toBe('/signin');
  });

  it('puts the policy on that redirect too, with a nonce', async () => {
    const response = await proxy(request('/dashboard'), event);
    expect(nonceOf(response)).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  // A Demo lets every request through the guard with no session, the one way to reach the
  // authorized branch here without minting a signed session token.
  describe('when the guard lets the request through', () => {
    afterEach(() => {
      delete process.env.RULEBEAT_DEMO;
    });

    it('forwards the nonce to the render and puts the same policy on the response', async () => {
      process.env.RULEBEAT_DEMO = '1';
      const response = await proxy(request('/dashboard', { cookie: 'theme=dark' }), event);
      expect(response.status).toBe(200);
      const nonce = nonceOf(response);
      expect(forwardedRequestHeader(response, 'x-nonce')).toBe(nonce);
      expect(forwardedRequestHeader(response, CSP)).toBe(response.headers.get(CSP));
      expect(forwardedRequestHeader(response, 'cookie')).toBe('theme=dark');
    });

    it('gets a different nonce on the next request', async () => {
      process.env.RULEBEAT_DEMO = '1';
      const first = nonceOf(await proxy(request('/dashboard'), event));
      const second = nonceOf(await proxy(request('/dashboard'), event));
      expect(first).not.toBe(second);
    });
  });
});

describe('proxy: nonces', () => {
  it('are different on every request', async () => {
    const first = nonceOf(await proxy(request('/signin'), event));
    const second = nonceOf(await proxy(request('/signin'), event));
    const third = nonceOf(await proxy(request('/dashboard'), event));
    expect(new Set([first, second, third]).size).toBe(3);
  });
});

describe('proxy: HSTS', () => {
  it('is sent when the client arrived over https behind a proxy', async () => {
    const response = await proxy(request('/signin', { 'x-forwarded-proto': 'https' }), event);
    expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000');
  });

  it('is not sent over plain http', async () => {
    const response = await proxy(request('/signin'), event);
    expect(response.headers.get('strict-transport-security')).toBeNull();
  });
});

describe('proxy: RULEBEAT_CSP=off', () => {
  it('drops the script policy and keeps frame-ancestors', async () => {
    process.env.RULEBEAT_CSP = 'off';
    const response = await proxy(request('/signin'), event);
    expect(response.headers.get(CSP)).toBe("frame-ancestors 'none'");
  });
});
