/**
 * `buildSecurityHeaders` is the one place the page policy and the HTTPS pin are decided, so these
 * tests pin the exact guarantees a browser sees: scripts only with the request's nonce, inline
 * styles still allowed (Tailwind and Recharts need them), framing always denied, and HSTS only on
 * a connection that actually arrived over HTTPS. Inputs are literals, never recomputed the way the
 * code computes them.
 */
import { describe, expect, it } from 'vitest';
import { buildSecurityHeaders, generateNonce } from '@/lib/security-headers';

const NONCE = 'dGVzdC1ub25jZS12YWx1ZQ==';

function build(opts: {
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string | undefined>;
}) {
  return buildSecurityHeaders({
    url: opts.url ?? 'http://localhost:3000/dashboard',
    headers: new Headers(opts.headers ?? {}),
    env: { NODE_ENV: 'production', ...opts.env },
    nonce: NONCE,
  });
}

/** The directive's value list, e.g. directive(csp, 'script-src') -> ["'self'", "'nonce-..'", ...]. */
function directive(csp: string, name: string): string[] | null {
  const found = csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));
  return found ? found.split(/\s+/).slice(1) : null;
}

describe('buildSecurityHeaders: the policy', () => {
  it('puts the request nonce, self and strict-dynamic in script-src', () => {
    const csp = build({})['Content-Security-Policy'];
    expect(directive(csp, 'script-src')).toEqual([
      "'self'",
      `'nonce-${NONCE}'`,
      "'strict-dynamic'",
    ]);
  });

  it('never allows inline or eval script in production', () => {
    const scriptSrc = directive(build({})['Content-Security-Policy'], 'script-src')!;
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it('adds unsafe-eval to script-src in development only, and still no unsafe-inline', () => {
    const scriptSrc = directive(
      build({ env: { NODE_ENV: 'development' } })['Content-Security-Policy'],
      'script-src',
    )!;
    expect(scriptSrc).toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it('keeps inline styles allowed, without a style nonce that would switch them off', () => {
    const styleSrc = directive(build({})['Content-Security-Policy'], 'style-src')!;
    expect(styleSrc).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it('denies framing and plugins and pins base-uri', () => {
    const csp = build({})['Content-Security-Policy'];
    expect(directive(csp, 'frame-ancestors')).toEqual(["'none'"]);
    expect(directive(csp, 'object-src')).toEqual(["'none'"]);
    expect(directive(csp, 'base-uri')).toEqual(["'self'"]);
  });

  it('restricts the remaining fetch directives to this origin', () => {
    const csp = build({})['Content-Security-Policy'];
    expect(directive(csp, 'default-src')).toEqual(["'self'"]);
    expect(directive(csp, 'img-src')).toEqual(["'self'", 'data:', 'blob:']);
    expect(directive(csp, 'font-src')).toEqual(["'self'", 'data:']);
    expect(directive(csp, 'connect-src')).toEqual(["'self'"]);
  });

  it('lets a form submission follow the redirect to Microsoft sign-in, and nowhere else', () => {
    expect(directive(build({})['Content-Security-Policy'], 'form-action')).toEqual([
      "'self'",
      'https://login.microsoftonline.com',
    ]);
  });

  it('is a single header value with no stray newlines', () => {
    expect(build({})['Content-Security-Policy']).not.toMatch(/[\r\n]/);
  });
});

describe('buildSecurityHeaders: HSTS', () => {
  const HSTS = 'Strict-Transport-Security';

  it('is sent for an https request URL, for a year, without subdomains or preload', () => {
    expect(build({ url: 'https://rulebeat.example/dashboard' })[HSTS]).toBe('max-age=31536000');
  });

  it('is sent when the URL is the bind address but the first forwarded hop was https', () => {
    const headers = build({
      url: 'http://0.0.0.0:3000/dashboard',
      headers: { 'x-forwarded-host': 'rulebeat.example', 'x-forwarded-proto': 'https, http' },
    });
    expect(headers[HSTS]).toBe('max-age=31536000');
  });

  it('is sent for a plain-http URL behind a proxy that says the client used https', () => {
    expect(
      build({ url: 'http://localhost:3000/', headers: { 'x-forwarded-proto': 'https' } })[HSTS],
    ).toBe('max-age=31536000');
  });

  it('is absent for plain http', () => {
    expect(build({ url: 'http://localhost:3000/dashboard' })[HSTS]).toBeUndefined();
  });

  it('is absent when only a later forwarded hop was https', () => {
    expect(
      build({ headers: { 'x-forwarded-proto': 'http, https' } })[HSTS],
    ).toBeUndefined();
  });

  it('is absent for the bind address when the forwarded proto says http', () => {
    const headers = build({
      url: 'http://0.0.0.0:3000/dashboard',
      headers: { 'x-forwarded-host': 'rulebeat.example', 'x-forwarded-proto': 'http' },
    });
    expect(headers[HSTS]).toBeUndefined();
  });

  it('is still sent with the script policy switched off', () => {
    expect(
      build({ url: 'https://rulebeat.example/', env: { RULEBEAT_CSP: 'off' } })[HSTS],
    ).toBe('max-age=31536000');
  });
});

describe('buildSecurityHeaders: RULEBEAT_CSP=off', () => {
  it('drops the script policy but keeps frame-ancestors none', () => {
    const csp = build({ env: { RULEBEAT_CSP: 'off' } })['Content-Security-Policy'];
    expect(directive(csp, 'script-src')).toBeNull();
    expect(csp).not.toContain('nonce-');
    expect(directive(csp, 'frame-ancestors')).toEqual(["'none'"]);
  });

  it('does not fall back to default-src, which would still block injected inline scripts', () => {
    const csp = build({ env: { RULEBEAT_CSP: 'off' } })['Content-Security-Policy'];
    expect(directive(csp, 'default-src')).toBeNull();
  });

  it('accepts the value in any case with surrounding spaces', () => {
    const csp = build({ env: { RULEBEAT_CSP: ' OFF ' } })['Content-Security-Policy'];
    expect(directive(csp, 'script-src')).toBeNull();
  });

  it('leaves the policy on for any other value, so a typo cannot silently weaken it', () => {
    for (const value of ['', 'false', '0', 'no', 'of']) {
      const csp = build({ env: { RULEBEAT_CSP: value } })['Content-Security-Policy'];
      expect(directive(csp, 'script-src')).not.toBeNull();
    }
  });
});

describe('generateNonce', () => {
  it('is 16 random bytes in base64', () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(Buffer.from(nonce, 'base64')).toHaveLength(16);
  });

  it('differs on every call', () => {
    expect(generateNonce()).not.toBe(generateNonce());
  });
});
