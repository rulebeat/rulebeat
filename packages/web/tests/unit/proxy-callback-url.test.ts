/**
 * RB-QA-016: next-auth@5.0.0-beta.31's own unauthenticated-redirect logic stamps the outer
 * `/signin` redirect from the request's real origin but the embedded `callbackUrl` param from a
 * different, container-internal-port fallback. It was reproduced against a running Docker
 * container. `fixCallbackUrlOrigin` (proxy.ts) is the fix: it trusts the outer redirect's own
 * origin (the part proven correct) and corrects the inner one to match, without touching
 * next-auth's internals. These tests exercise that function directly against the exact shape
 * curled from the container, since reproducing the real header-trust mismatch needs a request that
 * physically arrives on a different external port than the process listens on internally — not
 * reproducible against a local dev server bound to a single port.
 */
import { describe, expect, it } from 'vitest';
import { fixCallbackUrlOrigin } from '@/proxy';

function redirectResponse(location: string): Response {
  return new Response(null, { status: 307, headers: { location } });
}

describe('fixCallbackUrlOrigin', () => {
  it('rewrites callbackUrl to the redirect origin when they mismatch (the reported bug)', async () => {
    const response = redirectResponse(
      'http://myhost.example:8080/signin?callbackUrl=http%3A%2F%2Flocalhost%3A3000%2Fdashboard',
    );
    const fixed = fixCallbackUrlOrigin(response);
    expect(fixed.headers.get('location')).toBe(
      'http://myhost.example:8080/signin?callbackUrl=http%3A%2F%2Fmyhost.example%3A8080%2Fdashboard',
    );
  });

  it('preserves the callbackUrl path and query, only replacing scheme+host', async () => {
    const response = redirectResponse(
      'https://myhost.example/signin?callbackUrl=http%3A%2F%2Flocalhost%3A3000%2Fscans%3Ftab%3Dhistory',
    );
    const fixed = fixCallbackUrlOrigin(response);
    const location = new URL(fixed.headers.get('location')!);
    const callbackUrl = new URL(location.searchParams.get('callbackUrl')!);
    expect(callbackUrl.origin).toBe('https://myhost.example');
    expect(callbackUrl.pathname).toBe('/scans');
    expect(callbackUrl.searchParams.get('tab')).toBe('history');
  });

  it('leaves the response untouched when the origins already match', async () => {
    const location = 'http://localhost:3000/signin?callbackUrl=http%3A%2F%2Flocalhost%3A3000%2Fdashboard';
    const response = redirectResponse(location);
    const fixed = fixCallbackUrlOrigin(response);
    expect(fixed.headers.get('location')).toBe(location);
  });

  it('leaves the response untouched when there is no Location header (authenticated pass-through)', async () => {
    const response = new Response(null, { status: 200 });
    const fixed = fixCallbackUrlOrigin(response);
    expect(fixed.headers.get('location')).toBeNull();
    expect(fixed.status).toBe(200);
  });

  it('leaves the response untouched when the redirect has no callbackUrl param', async () => {
    const location = 'http://myhost.example/signin';
    const response = redirectResponse(location);
    const fixed = fixCallbackUrlOrigin(response);
    expect(fixed.headers.get('location')).toBe(location);
  });

  it('preserves other headers on the response (e.g. session cookies)', async () => {
    const response = new Response(null, {
      status: 307,
      headers: {
        location: 'http://myhost.example:8080/signin?callbackUrl=http%3A%2F%2Flocalhost%3A3000%2F',
        'set-cookie': 'authjs.csrf-token=abc; Path=/; HttpOnly',
      },
    });
    const fixed = fixCallbackUrlOrigin(response);
    expect(fixed.headers.get('set-cookie')).toBe('authjs.csrf-token=abc; Path=/; HttpOnly');
  });
});
