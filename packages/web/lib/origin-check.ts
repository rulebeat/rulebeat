const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Decides whether a state-changing request's `Origin` header can be trusted. This is the standard
 * header-based cross-site defence: a cross-site page can make a signed-in browser send a request
 * here (the session cookie rides along automatically) and can set whatever Origin its own browser
 * reports, but it cannot make that browser address a different Host.
 *
 * GET/HEAD/OPTIONS never change state, so they are always allowed regardless of Origin. No Origin
 * header at all is also allowed: curl, scripts and server-to-server calls carry no Origin, and none
 * of them is a browser a cross-site page could be driving. `Origin: null` (a sandboxed iframe, an
 * opaque-origin redirect) and an Origin that fails to parse as a URL can never equal a real origin,
 * so both are always refused.
 *
 * Two independent rules can each allow the request on their own:
 *
 * 1. The Origin's host and port match the host the browser actually addressed, taken from the
 *    first entry of `x-forwarded-host` when a proxy set one, else the raw `Host` header. Only the
 *    Origin's own scheme is used to fill in a missing port on either side (never
 *    `x-forwarded-proto`, which a proxy is not guaranteed to set), and the hostname comparison is
 *    case-insensitive. This is the rule that keeps working however this install was configured to
 *    be reached: a wrong or stale saved public URL can never lock out every write, including the
 *    Settings save that would fix it, and a TLS-terminating reverse proxy that forwards to an
 *    internal container hostname is not mistaken for a cross-site request just because the raw
 *    `Host` header disagrees with what the browser saw.
 * 2. The Origin equals the configured public URL's origin exactly (scheme, host and port, with
 *    the default port for each scheme treated as equivalent to no port at all). Kept as an
 *    additional allowance alongside rule 1, not a replacement for it, for an install that
 *    deliberately proxies one public origin onto a request whose own Host header never matches it.
 *
 * Refused when neither rule matches.
 */
export function checkRequestOrigin(
  method: string,
  headers: Headers,
  configuredPublicUrl: string | null,
): 'allow' | 'refuse' {
  if (SAFE_METHODS.has(method.toUpperCase())) return 'allow';

  const origin = headers.get('origin');
  if (!origin) return 'allow';
  if (origin === 'null') return 'refuse';

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return 'refuse';
  }

  if (originMatchesRequestHost(parsedOrigin, headers)) return 'allow';
  if (originMatchesConfiguredPublicUrl(parsedOrigin, configuredPublicUrl)) return 'allow';
  return 'refuse';
}

/** Rule 1: the Origin's host:port equals the host the browser addressed. */
function originMatchesRequestHost(origin: URL, headers: Headers): boolean {
  // First hop only: a proxy chain appends, and the first entry is the client-facing one. `host`
  // is the fallback for a runtime, or a direct request, that carries no forwarded header.
  const forwardedHost = headers.get('x-forwarded-host')?.split(',')[0]?.trim() || headers.get('host')?.trim();
  if (!forwardedHost) return false;

  let host: URL;
  try {
    host = new URL(`http://${forwardedHost}`);
  } catch {
    return false;
  }

  // The default port is filled in from the Origin's own scheme on both sides: `x-forwarded-proto`
  // is not guaranteed to be set by every proxy, so the Host header's port is never assumed to mean
  // anything about scheme, only about which port a missing one should be treated as equivalent to.
  const defaultPort = origin.protocol === 'https:' ? '443' : '80';
  return hostPortKey(origin, defaultPort) === hostPortKey(host, defaultPort);
}

/** Rule 2: the Origin equals the configured public URL's origin exactly (scheme, host, port). */
function originMatchesConfiguredPublicUrl(origin: URL, configuredPublicUrl: string | null): boolean {
  const trimmed = configuredPublicUrl?.trim();
  if (!trimmed) return false;

  let allowed: URL;
  try {
    allowed = new URL(trimmed);
  } catch {
    return false;
  }

  return schemeHostPortKey(origin) === schemeHostPortKey(allowed);
}

/** `host:port`, the given default port dropped so a missing port compares equal to it. */
function hostPortKey(url: URL, defaultPort: string): string {
  return `${url.hostname.toLowerCase()}:${url.port || defaultPort}`;
}

/** `scheme://host[:port]`, the default port for that scheme dropped so it compares equal to none. */
function schemeHostPortKey(url: URL): string {
  const isDefaultPort =
    url.port === '' || (url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80');
  const port = isDefaultPort ? '' : `:${url.port}`;
  return `${url.protocol}//${url.hostname.toLowerCase()}${port}`;
}
