/**
 * `proxy.ts`'s `matcher` decides what never reaches the auth guard at all, so a mistake in it is
 * invisible to every other auth test: the route still looks protected in the permission matrix
 * while the real request either 307s to /signin or sails past unauthenticated.
 *
 * The brand images are the case that made this worth pinning. They are fetched by clients that
 * have no session and never will (a Teams or Slack link-preview crawler, a signed-out browser
 * asking for the tab icon on the /signin page), so guarding them breaks the preview rather than
 * protecting anything. Excluding them safely then depends on the exclusion being exact, which is
 * the part a hand-written regex cannot check: Next rewrites the matcher string before using it,
 * and one of its rewrites (dropping backslash escapes) turns `favicon\.ico` into a pattern that
 * also matches `/faviconXico`. So assert through Next's own compiler, not a regex built here.
 */
import { unstable_doesMiddlewareMatch } from 'next/dist/experimental/testing/server/middleware-testing-utils';
import { describe, expect, it } from 'vitest';
import { config } from '@/proxy';

const guards = (pathname: string) =>
  unstable_doesMiddlewareMatch({ config, url: `http://localhost:3000${pathname}` });

describe('proxy matcher', () => {
  it.each([
    '/favicon.ico',
    '/icon.png',
    '/apple-icon.png',
    '/opengraph-image.png',
    '/brand/lockup.png',
    '/brand/lockup-dark.png',
    '/brand/mark.png',
    '/brand/mark-dark.png',
  ])('leaves %s unguarded, so a signed-out client can fetch it', (pathname) => {
    expect(guards(pathname)).toBe(false);
  });

  it.each([
    '/api/auth/session',
    '/signin',
    '/_next/static/chunk.js',
    '/_next/image',
  ])('leaves the pre-existing exclusion %s unguarded', (pathname) => {
    expect(guards(pathname)).toBe(false);
  });

  // The container liveness probe must be reachable with no session, same as the brand images above.
  it('leaves /api/health unguarded, so a container orchestrator can probe it with no session', () => {
    expect(guards('/api/health')).toBe(false);
  });

  it.each([
    '/',
    '/dashboard',
    '/scans',
    '/settings',
    '/api/rules',
  ])('still guards %s', (pathname) => {
    expect(guards(pathname)).toBe(true);
  });

  // The two ways an inexact exclusion leaks. Neither corresponds to a route that exists today,
  // which is exactly why they need a test: nothing else would notice one being added later.
  it.each([
    ['an unescaped dot matching any character', '/faviconXico'],
    ['an unescaped dot matching any character', '/iconXpng'],
    ['an unanchored exclusion used as a prefix', '/icon.png/private'],
    ['an unanchored exclusion used as a prefix', '/opengraph-image.png/private'],
    ['an unescaped dot matching any character', '/brand/lockupXpng'],
    ['an unanchored exclusion used as a prefix', '/brand/lockup.png/private'],
    // /api/health's own exclusion is anchored with $ for exactly this reason: review of the first
    // draft caught it using a bare, unanchored prefix here.
    ['an unanchored exclusion used as a prefix', '/api/healthx'],
    ['an unanchored exclusion used as a prefix', '/api/health/private'],
  ])('guards %s: %s', (_why, pathname) => {
    expect(guards(pathname)).toBe(true);
  });
});
