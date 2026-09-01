import { describe, it, expect } from 'vitest';
import {
  redirectUriFor,
  isLoopbackIpOrigin,
  normalizeLoopbackOrigin,
} from '@/lib/redirect-uri';

// Written after Microsoft sign-in could not be configured at all from the documented quickstart
// install (issue #49). install.md says to bind `-p 127.0.0.1:3000:3000`, so the operator browses
// 127.0.0.1, and Settings faithfully showed them
// `http://127.0.0.1:3000/api/auth/callback/microsoft-entra-id` as the value to register. Entra
// refuses it outright: redirect URIs must be https, or http://localhost by name.

describe('redirectUriFor', () => {
  it('appends the callback path', async () => {
    expect(redirectUriFor('https://rulebeat.example.com')).toBe(
      'https://rulebeat.example.com/api/auth/callback/microsoft-entra-id'
    );
  });

  it('does not double the slash when the origin has a trailing one', async () => {
    expect(redirectUriFor('https://rulebeat.example.com/')).toBe(
      'https://rulebeat.example.com/api/auth/callback/microsoft-entra-id'
    );
  });
});

describe('isLoopbackIpOrigin', () => {
  it('flags the address the quickstart tells people to bind', async () => {
    expect(isLoopbackIpOrigin('http://127.0.0.1:3000')).toBe(true);
  });

  it('flags the whole 127.0.0.0/8 range, not just 127.0.0.1', async () => {
    expect(isLoopbackIpOrigin('http://127.0.0.53:3000')).toBe(true);
    expect(isLoopbackIpOrigin('http://127.1.2.3:3000')).toBe(true);
  });

  it('flags IPv6 loopback in bracketed form', async () => {
    expect(isLoopbackIpOrigin('http://[::1]:3000')).toBe(true);
  });

  it('does NOT flag localhost, which is the form Entra accepts', async () => {
    expect(isLoopbackIpOrigin('http://localhost:3000')).toBe(false);
  });

  it('does not flag a real hostname, however digit-heavy', async () => {
    expect(isLoopbackIpOrigin('https://rulebeat.example.com')).toBe(false);
    expect(isLoopbackIpOrigin('https://10-0-0-1.example.com')).toBe(false);
  });

  it('does not flag a non-loopback IP literal, which is a different problem', async () => {
    // 10.0.0.4 is equally unusable in Entra, but rewriting it to localhost would be wrong: it is
    // a real address someone else reaches this install on.
    expect(isLoopbackIpOrigin('http://10.0.0.4:3000')).toBe(false);
    expect(isLoopbackIpOrigin('http://192.168.1.10:3000')).toBe(false);
  });

  it('does not flag a malformed address, which the URL parser rejects before we see it', async () => {
    // Not our own octet check: `new URL('http://127.999.0.1:3000')` throws, so this lands in the
    // same catch as outright junk. Asserted so that stays true if the parsing ever moves.
    expect(() => new URL('http://127.999.0.1:3000')).toThrow();
    expect(isLoopbackIpOrigin('http://127.999.0.1:3000')).toBe(false);
  });

  it('returns false for something that is not a URL at all', async () => {
    expect(isLoopbackIpOrigin('not a url')).toBe(false);
    expect(isLoopbackIpOrigin('')).toBe(false);
  });
});

describe('normalizeLoopbackOrigin', () => {
  it('rewrites the host to localhost and keeps the port', async () => {
    expect(normalizeLoopbackOrigin('http://127.0.0.1:3000')).toBe('http://localhost:3000');
  });

  it('keeps a non-default scheme and port intact', async () => {
    expect(normalizeLoopbackOrigin('https://127.0.0.1:8443')).toBe('https://localhost:8443');
  });

  it('rewrites IPv6 loopback too', async () => {
    expect(normalizeLoopbackOrigin('http://[::1]:3000')).toBe('http://localhost:3000');
  });

  it('leaves localhost alone', async () => {
    expect(normalizeLoopbackOrigin('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('leaves a real origin completely alone', async () => {
    expect(normalizeLoopbackOrigin('https://rulebeat.example.com')).toBe(
      'https://rulebeat.example.com'
    );
  });

  it('leaves a non-loopback IP alone, since localhost would be a lie there', async () => {
    expect(normalizeLoopbackOrigin('http://10.0.0.4:3000')).toBe('http://10.0.0.4:3000');
  });

  it('returns unparseable input unchanged rather than throwing', async () => {
    expect(normalizeLoopbackOrigin('not a url')).toBe('not a url');
  });

  it('produces a redirect URI Entra will accept, end to end', async () => {
    const origin = 'http://127.0.0.1:3000';
    expect(redirectUriFor(normalizeLoopbackOrigin(origin))).toBe(
      'http://localhost:3000/api/auth/callback/microsoft-entra-id'
    );
  });
});
