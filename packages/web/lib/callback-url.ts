const FALLBACK = '/dashboard';

/**
 * The path a sign-in may send someone to, or `/dashboard`. Accepts a relative path with a single
 * leading `/`, and an absolute URL on the request's own origin (the form `fixCallbackUrlOrigin`
 * in proxy.ts writes), reduced to path+search+hash. Everything else is an open redirect waiting
 * to happen and falls back.
 *
 * The reduced path is checked again after parsing: the URL parser turns `\` into `/` for http(s),
 * so `https://host/\evil.example` arrives as the protocol-relative `//evil.example`.
 */
export function safeCallbackPath(raw: unknown, requestOrigin: string | null): string {
  if (typeof raw !== 'string') return FALLBACK;
  if (raw.startsWith('/')) return isSafeRelative(raw) ? raw : FALLBACK;
  if (!requestOrigin) return FALLBACK;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return FALLBACK;
  }
  if (parsed.origin !== requestOrigin) return FALLBACK;
  const reduced = parsed.pathname + parsed.search + parsed.hash;
  return isSafeRelative(reduced) ? reduced : FALLBACK;
}

// A control character is refused outright: browsers drop tab and newline from a URL, so
// `/<tab>/host` would become `//host` after the check.
function isSafeRelative(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(path);
}

/**
 * The origin the browser used, from the request headers. Same sources as `correctedRequestUrl`
 * (first hop of `x-forwarded-host`, else `host`), with the protocol from `x-forwarded-proto`,
 * else the `Origin` header a browser sends on every form POST, else http.
 */
export function requestOriginFrom(headers: Headers): string | null {
  const host = headers.get('x-forwarded-host')?.split(',')[0]?.trim() || headers.get('host')?.trim();
  if (!host) return null;

  let proto = headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  if (proto !== 'https' && proto !== 'http') {
    const origin = headers.get('origin');
    proto = origin?.startsWith('https://') ? 'https' : 'http';
  }
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return null;
  }
}
