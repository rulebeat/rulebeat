/**
 * Where Entra must send someone back to, for the app registration's Authentication settings.
 *
 * Client-safe on purpose (no server imports) so both `sign-in-section.tsx` and the onboarding
 * Connect step can call it directly instead of duplicating the string template.
 */
export function redirectUriFor(origin: string): string {
  return `${origin.replace(/\/$/, '')}/api/auth/callback/microsoft-entra-id`;
}

/**
 * Whether an origin's host is a loopback IP literal rather than a name.
 *
 * This matters because Entra will not accept one. Its redirect URIs must be `https://`, with a
 * single exception for `http://localhost` by name; `http://127.0.0.1` is refused by the portal
 * ("Must start with HTTPS or http://localhost") and by the sign-in request
 * (`AADSTS50011: The redirect URI ... does not match`).
 *
 * That is not a hypothetical: `docs/public/install.md` tells people to bind to
 * `-p 127.0.0.1:3000:3000`, so browsing the address they were told to use is what produces an
 * origin no app registration can ever be configured to match.
 *
 * Matches all of 127.0.0.0/8, not just 127.0.0.1, and IPv6 loopback in both bracketed and bare
 * forms. A hostname that merely contains digits (`10-0-0-1.example.com`) is not a literal and is
 * left alone.
 */
export function isLoopbackIpOrigin(origin: string): boolean {
  return loopbackHostOf(origin) !== null;
}

/**
 * The same origin with a loopback IP host replaced by `localhost`, preserving scheme and port.
 * Any other origin is returned unchanged, including one that is already `localhost`.
 *
 * Rewriting only what is displayed is not a fix on its own: the runtime `redirect_uri` comes from
 * `AUTH_URL` when set, and otherwise from the request's own host (`auth.config.ts` sets
 * `trustHost: true`). Showing `localhost` while the browser sits on `127.0.0.1` moves the mismatch
 * rather than resolving it, which is why the callers pair this with a message telling the operator
 * to browse and configure the public URL under the same name.
 */
export function normalizeLoopbackOrigin(origin: string): string {
  const host = loopbackHostOf(origin);
  if (host === null) return origin;

  try {
    const url = new URL(origin);
    url.hostname = 'localhost';
    // `toString()` appends a trailing slash for a bare origin; redirectUriFor strips it, but keep
    // the shape identical to what came in so a caller comparing the two sees only the host change.
    return url.toString().replace(/\/$/, '');
  } catch {
    return origin;
  }
}

/**
 * The loopback host of an origin, or null when it has none.
 *
 * `URL.hostname` normalizes IPv6 to its bracketed form, so `::1` and `[::1]` both arrive here as
 * `[::1]`.
 */
function loopbackHostOf(origin: string): string | null {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    // Covers a malformed address as well as outright junk: the WHATWG parser runs its own IPv4
    // validation, so `http://127.999.0.1` throws here rather than arriving with out-of-range
    // octets. No octet check of our own is reachable below because of that.
    return null;
  }

  if (/^127(\.\d{1,3}){3}$/.test(hostname)) return hostname;
  if (hostname === '[::1]' || hostname === '::1') return hostname;

  return null;
}
