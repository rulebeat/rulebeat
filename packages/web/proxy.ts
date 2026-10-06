import NextAuth from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';
import type { NextFetchEvent } from 'next/server';
import { authConfig } from '@/auth.config';
import { correctedRequestUrl } from '@/lib/request-origin';
import { checkRequestOrigin } from '@/lib/origin-check';
import { buildSecurityHeaders, generateNonce } from '@/lib/security-headers';

// A second NextAuth instance built from the DB-free config, not `@/auth` — the proxy runs on
// every non-excluded request and only needs to decode the JWT and check one claim, so it has no
// business opening SQLite at import time to build a provider list it never uses. The two configs
// sharing `getAuthSecret()` is what keeps them able to read each other's tokens; see the test in
// tests/unit/auth-config.test.ts for the failure mode if that ever drifts (a silent infinite
// redirect to /signin while the app itself works fine).
//
// `.auth`'s declared type is a union of overloads for its other call shapes (zero-arg session
// read, wrapping a route handler, wrapping a middleware function) — none of them is literally
// "(req, event) => Promise<Response>", even though that's exactly how Next.js invokes a proxy's
// default export at runtime (this is next-auth's own documented `export { auth as middleware }`
// pattern). Assert the real shape rather than let overload resolution pick the wrong candidate.
type ProxyHandler = (req: NextRequest, event: NextFetchEvent) => Promise<Response>;
const authHandler = NextAuth(authConfig).auth as unknown as ProxyHandler;

// next-auth@5.0.0-beta.31's own unauthenticated-redirect logic (handleAuth in
// next-auth/lib/index.js) builds the outer redirect (to /signin) from the request's real,
// forwarded-header-correct URL, but stamps the embedded `callbackUrl` param from a differently
// resolved value that falls back to the container's internal PORT — so behind a reverse proxy
// (external port != internal 3000) sign-in lands you back on an unreachable localhost:3000
// (QA-BUG-LOG RB-QA-016). Confirmed by reading next-auth's source, not guessed. Rather than patch
// a pre-release dependency's internals blind, correct it at our own boundary: the outer redirect's
// origin is the one proven correct by curl reproduction against a running container, so use it to
// fix up the one inconsistent piece of next-auth's own response.
export function fixCallbackUrlOrigin(response: Response): Response {
  const location = response.headers.get('location');
  if (!location) return response;

  let redirectUrl: URL;
  try {
    redirectUrl = new URL(location);
  } catch {
    return response;
  }

  const callbackParam = redirectUrl.searchParams.get('callbackUrl');
  if (!callbackParam) return response;

  let callbackUrl: URL;
  try {
    callbackUrl = new URL(callbackParam);
  } catch {
    return response;
  }

  if (callbackUrl.origin === redirectUrl.origin) return response;

  // `.host =` alone won't do: the WHATWG URL setter only touches the hostname when the new
  // value carries no port, leaving a stale one from the old origin behind (e.g. localhost:3000's
  // "3000" surviving onto myhost.example). Clear the port explicitly via its own setter.
  callbackUrl.protocol = redirectUrl.protocol;
  callbackUrl.hostname = redirectUrl.hostname;
  callbackUrl.port = redirectUrl.port;
  redirectUrl.searchParams.set('callbackUrl', callbackUrl.toString());
  response.headers.set('location', redirectUrl.toString());
  return response;
}

// `export default` of a plain function (not a destructured `export const { auth: proxy } = ...`)
// is deliberate — Next.js's proxy-export check rejected the destructured form outright ("must
// export a function") even though it evaluates to one; wrapping `authHandler` this way keeps that
// same shape.
// The standalone server hands this proxy a request whose URL carries the bind address
// (0.0.0.0), not the browser's — and the auth handler embeds that URL's origin into the
// `callbackUrl` it sends people to /signin with, which lands them on 0.0.0.0 after signing in
// (#49). Rebuild the request on the corrected origin first; see lib/request-origin.ts. Bodyless
// on purpose: the auth decision reads the URL, method, headers and the cookies they carry, never
// a body — /api/auth and /signin are outside the matcher above, and the route the request
// continues to still receives the original, body intact.
function correctProxyRequest(req: NextRequest): NextRequest {
  const corrected = correctedRequestUrl(req.url, req.headers);
  if (!corrected) return req;
  return new NextRequest(corrected, { headers: req.headers, method: req.method });
}

export default async function proxy(req: NextRequest, event: NextFetchEvent) {
  // A state-changing request whose Origin disagrees with where this install is reachable never
  // reaches the auth guard at all — see lib/origin-check.ts. AUTH_URL (not getPublicUrl() itself)
  // is read here because it is the env-mirrored value sign-in-config.ts keeps in sync, safe to
  // read in the proxy's runtime with no database access, the same reason auth.config.ts stays
  // DB-free. /signin runs through the proxy now, so its form posts are checked the same way.
  if (checkRequestOrigin(req.method, req.headers, process.env.AUTH_URL ?? null) === 'refuse') {
    return withSecurityHeaders(
      req,
      NextResponse.json({ error: 'This request did not come from an allowed origin.' }, { status: 403 }),
    );
  }
  const response = isPublicPage(req)
    ? NextResponse.next()
    : fixCallbackUrlOrigin(await authHandler(correctProxyRequest(req), event));
  return withSecurityHeaders(req, response);
}

// `/signin` used to sit outside the matcher so the guard never saw it. The page policy has to be
// stamped on it too, so it now runs through the proxy and this is what keeps the guard off it. The
// test is the old exclusion verbatim, an unanchored prefix, so exactly the same paths stay public.
function isPublicPage(req: NextRequest): boolean {
  return req.nextUrl.pathname.startsWith('/signin');
}

// Stamps the page policy (lib/security-headers.ts) on the response and, for a request that is
// going on to render, forwards the nonce to that render. Next reads the nonce back out of the
// Content-Security-Policy *request* header to stamp its own scripts, and the layout reads `x-nonce`
// for the one inline script it owns. A request that only gets redirected renders nothing, so it
// takes the response headers alone.
function withSecurityHeaders(req: NextRequest, response: Response): Response {
  const nonce = generateNonce();
  const security = buildSecurityHeaders({
    url: req.url,
    headers: req.headers,
    env: { NODE_ENV: process.env.NODE_ENV, RULEBEAT_CSP: process.env.RULEBEAT_CSP },
    nonce,
  });
  for (const [name, value] of Object.entries(security)) response.headers.set(name, value);

  if (response.headers.get('x-middleware-next') === '1') {
    // Same override NextResponse.next({ request: { headers } }) writes. The auth handler's own
    // pass-through response carries none, so copy it across rather than build a second response
    // and lose the session cookies the handler appended to this one. Setting (not appending) the
    // two names also discards any value the client sent for them.
    const forwarded = new Headers(req.headers);
    forwarded.set('x-nonce', nonce);
    forwarded.set('Content-Security-Policy', security['Content-Security-Policy']);
    const override = NextResponse.next({ request: { headers: forwarded } });
    for (const [name, value] of override.headers) {
      if (name.startsWith('x-middleware-') && name !== 'x-middleware-next') {
        response.headers.set(name, value);
      }
    }
  }
  return response;
}

// The brand images sit outside the guard alongside favicon.ico, for the same reason it already
// does: they are fetched by clients that have no session and never will. A link-preview crawler
// (Teams, Slack) fetching opengraph-image.png is not signed in, and a signed-out visitor's browser
// still asks for the tab and touch icons on the /signin page. Left guarded, each one 307s to
// /signin and the preview or icon silently fails. Nothing is disclosed by allowing them: they are
// static artwork, and /signin itself is already public and already says this is a RuleBeat install.
//
// The four filenames are exact, the four prefixes above them are not, and the difference is
// deliberate. `[.]` rather than `\.` because Next strips the backslash while compiling this string
// (`getMiddlewareMatchers`), so an escaped dot silently becomes "any character" and `/iconXpng`
// walks straight past the guard; a character class survives compilation. `$` pins the exclusion to
// the whole path, so `/icon.png/anything` cannot be used as a prefix to reach past it either.
// Both forms are asserted against Next's own matcher compiler in tests/unit/proxy-matcher.test.ts,
// not against a hand-rolled regex, because the compiler is what rewrites them.
//
// `api/health$` is anchored the same way: it's a single unauthenticated liveness route, not a
// route prefix like `api/auth`, so an unanchored entry would silently unguard `/api/healthx` and
// `/api/health/private` too. The first draft of this line used a bare, unanchored prefix.
//
// `signin` is deliberately no longer in the list. This matcher now decides which responses get the
// page policy as well as which reach the guard, and /signin is an HTML page that needs the policy
// most. It still never reaches the guard: `isPublicPage` skips it inside the function. `api/auth`
// stays excluded because it answers with redirects and JSON, plus Auth.js's own bare sign-out
// page, which has no script; the static `frame-ancestors` in next.config.ts still covers that.
export const config = {
  matcher: [
    '/((?!api/auth|_next/static|_next/image|favicon[.]ico$|icon[.]png$|apple-icon[.]png$|opengraph-image[.]png$|brand/lockup[.]png$|brand/lockup-dark[.]png$|brand/mark[.]png$|brand/mark-dark[.]png$|api/health$).*)',
  ],
};
