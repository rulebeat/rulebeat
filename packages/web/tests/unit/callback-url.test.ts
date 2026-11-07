import { describe, expect, it } from 'vitest';
import { requestOriginFrom, safeCallbackPath } from '@/lib/callback-url';

const ORIGIN = 'https://rulebeat.example.com';

describe('safeCallbackPath', () => {
  it('accepts a relative path and keeps search and hash', () => {
    expect(safeCallbackPath('/scans?tab=history&category=Storage#row-3', ORIGIN))
      .toBe('/scans?tab=history&category=Storage#row-3');
  });

  it('accepts the same-origin absolute form the proxy writes, reduced to path, search and hash', () => {
    expect(safeCallbackPath(`${ORIGIN}/scans?tab=history#row-3`, ORIGIN))
      .toBe('/scans?tab=history#row-3');
  });

  it('accepts the bare root', () => {
    expect(safeCallbackPath('/', ORIGIN)).toBe('/');
    expect(safeCallbackPath(`${ORIGIN}`, ORIGIN)).toBe('/');
  });

  it.each([
    ['a foreign absolute URL', 'https://evil.example.net/dashboard'],
    ['the same host on another scheme', 'http://rulebeat.example.com/dashboard'],
    ['the same host on another port', 'https://rulebeat.example.com:8443/dashboard'],
    ['a protocol-relative //host', '//evil.example.net/x'],
    ['a backslash /\\host', '/\\evil.example.net/x'],
    ['a same-origin absolute URL whose path is //host', `${ORIGIN}//evil.example.net/x`],
    ['a same-origin absolute URL whose path is /\\host', `${ORIGIN}/\\evil.example.net/x`],
    ['a tab hidden inside the leading slashes', '/\t/evil.example.net/x'],
    ['a newline hidden inside the leading slashes', '/\n/evil.example.net/x'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a bare relative path', 'dashboard'],
    ['an empty string', ''],
  ])('falls back to /dashboard for %s', (_label, raw) => {
    expect(safeCallbackPath(raw, ORIGIN)).toBe('/dashboard');
  });

  it('falls back to /dashboard for a missing or non-string value', () => {
    expect(safeCallbackPath(null, ORIGIN)).toBe('/dashboard');
    expect(safeCallbackPath(undefined, ORIGIN)).toBe('/dashboard');
    expect(safeCallbackPath(new Blob([]), ORIGIN)).toBe('/dashboard');
  });

  it('refuses every absolute URL when the request origin is unknown, but still accepts a relative path', () => {
    expect(safeCallbackPath(`${ORIGIN}/scans`, null)).toBe('/dashboard');
    expect(safeCallbackPath('/scans', null)).toBe('/scans');
  });
});

describe('requestOriginFrom', () => {
  it('uses the forwarded host and protocol, first hop only', () => {
    const h = new Headers({ 'x-forwarded-host': 'a.example.com, b.internal', 'x-forwarded-proto': 'https, http' });
    expect(requestOriginFrom(h)).toBe('https://a.example.com');
  });

  it('falls back to Host and the protocol of the Origin header', () => {
    const h = new Headers({ host: 'a.example.com:8443', origin: 'https://a.example.com:8443' });
    expect(requestOriginFrom(h)).toBe('https://a.example.com:8443');
  });

  it('assumes http when nothing says otherwise', () => {
    expect(requestOriginFrom(new Headers({ host: 'localhost:3000' }))).toBe('http://localhost:3000');
  });

  it('is null without a host', () => {
    expect(requestOriginFrom(new Headers())).toBeNull();
  });
});
