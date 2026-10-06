/**
 * The origin check (lib/origin-check.ts) is wired into the proxy's default export itself, ahead of
 * the Auth.js guard: a refused request must never reach `authHandler` at all, so a session cookie
 * that rode along on a cross-site request is never even evaluated.
 *
 * `next-auth` is mocked so `authHandler` (built once, at module import time, from
 * `NextAuth(authConfig).auth`) is a spy — proving the auth handler is skipped entirely on a
 * refusal, not merely that its result is overridden afterwards.
 */
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { NextFetchEvent } from 'next/server';

const { authHandlerMock } = vi.hoisted(() => ({
  authHandlerMock: vi.fn(async () => new Response(null, { status: 200 })),
}));

vi.mock('next-auth', () => ({
  __esModule: true,
  default: () => ({ auth: authHandlerMock }),
}));

// Pin the configured public URL this suite checks requests against, rather than rely on
// tests/setup.ts's own default staying what it is today.
process.env.AUTH_URL = 'https://rulebeat.example.com';

const { default: proxy } = await import('@/proxy');

const fakeEvent = {} as NextFetchEvent;

function request(url: string, init: { method: string; headers?: Record<string, string> }): NextRequest {
  return new NextRequest(url, { method: init.method, headers: init.headers });
}

describe('proxy default export — origin refusal', () => {
  it('refuses a cross-origin POST with 403 before the auth handler ever runs', async () => {
    const res = await proxy(
      request('https://rulebeat.example.com/api/rules', {
        method: 'POST',
        headers: { origin: 'https://evil.example' },
      }),
      fakeEvent,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'This request did not come from an allowed origin.' });
    expect(authHandlerMock).not.toHaveBeenCalled();
  });

  it('still reaches the auth handler for a same-origin POST', async () => {
    authHandlerMock.mockClear();
    const res = await proxy(
      request('https://rulebeat.example.com/api/rules', {
        method: 'POST',
        headers: { origin: 'https://rulebeat.example.com' },
      }),
      fakeEvent,
    );

    expect(authHandlerMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it('still reaches the auth handler for a GET with a mismatched Origin', async () => {
    authHandlerMock.mockClear();
    const res = await proxy(
      request('https://rulebeat.example.com/dashboard', {
        method: 'GET',
        headers: { origin: 'https://evil.example' },
      }),
      fakeEvent,
    );

    expect(authHandlerMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });
});
