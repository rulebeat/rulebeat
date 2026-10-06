/**
 * `checkRequestOrigin` (lib/origin-check.ts) is the header-based cross-site defence: the only
 * thing that stood between a signed-in session cookie and a state-changing request forged by
 * another site was the cookie's SameSite=Lax attribute. This is the second, independent layer —
 * a state-changing request whose Origin header does not match where the browser actually sent it,
 * and does not match the configured public URL either, is refused before it reaches the auth
 * guard or any route handler.
 */
import { describe, expect, it } from 'vitest';
import { checkRequestOrigin } from '../../lib/origin-check';

const h = (entries: Record<string, string>) => new Headers(entries);

describe('checkRequestOrigin', () => {
  it('allows a same-origin POST', () => {
    expect(
      checkRequestOrigin(
        'POST',
        h({ origin: 'https://rulebeat.example.com', host: 'rulebeat.example.com' }),
        null,
      ),
    ).toBe('allow');
  });

  it('refuses a POST whose Origin matches neither the request Host nor any configured public URL', () => {
    expect(
      checkRequestOrigin(
        'POST',
        h({ origin: 'https://evil.example', host: 'rulebeat.example.com' }),
        'https://rulebeat.example.com',
      ),
    ).toBe('refuse');
  });

  it('allows a request with no Origin header at all (curl, scripts, server-to-server)', () => {
    expect(checkRequestOrigin('POST', h({ host: 'rulebeat.example.com' }), null)).toBe('allow');
  });

  it('refuses Origin: null (a sandboxed iframe or opaque-origin redirect)', () => {
    expect(
      checkRequestOrigin('POST', h({ origin: 'null', host: 'rulebeat.example.com' }), null),
    ).toBe('refuse');
  });

  it('refuses an Origin header that does not parse as a URL', () => {
    expect(
      checkRequestOrigin('POST', h({ origin: 'not-a-url', host: 'rulebeat.example.com' }), null),
    ).toBe('refuse');
  });

  it('allows a request whose Origin matches Host even when the saved public URL is wrong', () => {
    // The public URL an admin saved has a stale scheme/host/typo, but that must never lock out
    // every write, including the Settings save that would fix it.
    expect(
      checkRequestOrigin(
        'POST',
        h({ origin: 'https://rulebeat.example.com', host: 'rulebeat.example.com' }),
        'https://wrong-saved-url.example',
      ),
    ).toBe('allow');
  });

  it('allows a request behind a TLS-terminating proxy that rewrites Host to an internal container name', () => {
    // The proxy terminates TLS and forwards to the container's own hostname, so the raw Host
    // header is internal, but x-forwarded-host still carries the name the browser addressed.
    expect(
      checkRequestOrigin(
        'POST',
        h({
          origin: 'https://rulebeat.example.com',
          host: 'backend-container:3000',
          'x-forwarded-host': 'rulebeat.example.com',
        }),
        null,
      ),
    ).toBe('allow');
  });

  it('uses the first entry of x-forwarded-host over later entries and over the Host header', () => {
    expect(
      checkRequestOrigin(
        'POST',
        h({
          origin: 'https://rulebeat.example.com',
          host: 'ignored-host.example',
          'x-forwarded-host': 'rulebeat.example.com, proxy-hop-two.example',
        }),
        null,
      ),
    ).toBe('allow');
  });

  it('the configured public URL is an additional allow path when the Origin disagrees with Host', () => {
    expect(
      checkRequestOrigin(
        'POST',
        h({ origin: 'https://rulebeat.example.com', host: 'internal-lb:8080' }),
        'https://rulebeat.example.com',
      ),
    ).toBe('allow');
  });

  it('normalises the default port for https (443) against a Host with no port', () => {
    expect(
      checkRequestOrigin('POST', h({ origin: 'https://rulebeat.example.com', host: 'rulebeat.example.com' }), null),
    ).toBe('allow');
  });

  it('normalises the default port for https (443) against a Host with an explicit :443', () => {
    expect(
      checkRequestOrigin(
        'POST',
        h({ origin: 'https://rulebeat.example.com', host: 'rulebeat.example.com:443' }),
        null,
      ),
    ).toBe('allow');
  });

  it('matches an explicit non-default port on both sides', () => {
    expect(
      checkRequestOrigin(
        'POST',
        h({ origin: 'http://rulebeat.example.com:3000', host: 'rulebeat.example.com:3000' }),
        null,
      ),
    ).toBe('allow');
  });

  it('refuses when an explicit non-default Origin port disagrees with the Host port', () => {
    expect(
      checkRequestOrigin(
        'POST',
        h({ origin: 'http://rulebeat.example.com:3000', host: 'rulebeat.example.com' }),
        null,
      ),
    ).toBe('refuse');
  });

  it('compares hostnames case-insensitively', () => {
    expect(
      checkRequestOrigin(
        'POST',
        h({ origin: 'https://RuleBeat.Example.com', host: 'rulebeat.example.com' }),
        null,
      ),
    ).toBe('allow');
  });

  it('never refuses GET, regardless of Origin', () => {
    expect(
      checkRequestOrigin('GET', h({ origin: 'https://evil.example', host: 'rulebeat.example.com' }), null),
    ).toBe('allow');
  });

  it('never refuses HEAD or OPTIONS either', () => {
    expect(
      checkRequestOrigin('HEAD', h({ origin: 'https://evil.example', host: 'rulebeat.example.com' }), null),
    ).toBe('allow');
    expect(
      checkRequestOrigin('OPTIONS', h({ origin: 'https://evil.example', host: 'rulebeat.example.com' }), null),
    ).toBe('allow');
  });
});
