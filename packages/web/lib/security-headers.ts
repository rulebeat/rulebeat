import { correctedRequestUrl } from '@/lib/request-origin';

/**
 * The response headers every HTML page carries beyond the static set in next.config.ts: a
 * Content-Security-Policy that lets only scripts RuleBeat rendered itself run, and
 * Strict-Transport-Security on connections that arrived over HTTPS. A pure function of the
 * request, so it is testable without Next; proxy.ts wires it in (the nonce has to be minted per
 * request, which a static config header cannot do).
 *
 * Scripts carry the request's nonce and `'strict-dynamic'` lets those scripts load the chunks they
 * need. There is no `'unsafe-inline'` for scripts. Styles keep `'unsafe-inline'` because Tailwind
 * and Recharts write inline style attributes; a nonce on `style-src` would make browsers ignore
 * `'unsafe-inline'` and break them, so none is added.
 */

export interface SecurityHeaderInput {
  /** The request URL as the server sees it (the bind address in standalone; corrected below). */
  url: string;
  headers: Headers;
  env: { NODE_ENV?: string; RULEBEAT_CSP?: string };
  nonce: string;
}

const HSTS_VALUE = 'max-age=31536000';

// The authority the Entra sign-in redirect chain ends at. Browsers apply `form-action` to every
// redirect a form submission follows, so without it the "Sign in with Microsoft" form posts fine
// and then the redirect to Microsoft is blocked.
const FORM_ACTION_HOSTS = ['https://login.microsoftonline.com'];

/** 16 random bytes, base64: the nonce format Next.js reads back out of the policy header. */
export function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

export function buildSecurityHeaders({
  url,
  headers,
  env,
  nonce,
}: SecurityHeaderInput): Record<string, string> {
  const result: Record<string, string> = {
    'Content-Security-Policy': policy(nonce, env),
  };
  if (arrivedOverHttps(url, headers)) result['Strict-Transport-Security'] = HSTS_VALUE;
  return result;
}

function policy(nonce: string, env: SecurityHeaderInput['env']): string {
  // Escape hatch for a browser extension or reverse proxy that injects scripts into pages. Only
  // the exact value `off` counts, so a typo leaves the policy on rather than silently dropping it.
  // Without script-src or default-src there is nothing to block injected scripts, so the policy
  // shrinks to the framing rule and nothing else.
  if (env.RULEBEAT_CSP?.trim().toLowerCase() === 'off') return "frame-ancestors 'none'";

  // React's dev tooling rebuilds server stacks with eval; production never needs it.
  const scriptSrc = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  if (env.NODE_ENV === 'development') scriptSrc.push("'unsafe-eval'");

  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    `form-action 'self' ${FORM_ACTION_HOSTS.join(' ')}`,
    "frame-ancestors 'none'",
  ].join('; ');
}

// HTTPS is read from the corrected URL (the standalone server reports the bind address and
// `http:`, see lib/request-origin.ts) or from the first forwarded hop, the client-facing one. A
// later hop is an internal proxy talking to another and says nothing about the browser.
function arrivedOverHttps(url: string, headers: Headers): boolean {
  const effective = correctedRequestUrl(url, headers) ?? url;
  try {
    if (new URL(effective).protocol === 'https:') return true;
  } catch {
    // An unparseable URL falls through to the forwarded header.
  }
  return headers.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https';
}
