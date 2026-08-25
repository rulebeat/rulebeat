import { NextRequest } from 'next/server';

/**
 * Corrects the one origin Next.js standalone gets wrong on purpose.
 *
 * The standalone server (`output: 'standalone'`, what the Docker image runs) rebuilds every
 * request's URL from the address it *binds* to, not the address the browser used:
 * `${protocol}://${fetchHostname}:${port}` in next-server's `attachRequestMeta`, where
 * `fetchHostname` is the container's `HOSTNAME=0.0.0.0`. So with no `AUTH_URL` configured,
 * everything Auth.js derives from the request URL says `http://0.0.0.0:3000`: the post-sign-in
 * redirect, the sign-in error redirect, the `callbackUrl` the route guard embeds, and the
 * `redirect_uri` sent to Microsoft. Browsers cannot sit on 0.0.0.0, so sign-in dead-ends there
 * (#49).
 *
 * The real origin still arrives on every request: Next fills `x-forwarded-host` from the actual
 * `Host` header when no reverse proxy set one (base-server, a `??=`, never an overwrite). So this
 * rewrites the URL's origin from the forwarded headers, and only when the URL's host is an
 * address that cannot be browsed at all: the IPv4/IPv6 *unspecified* addresses `0.0.0.0` and
 * `[::]`, which exist to mean "every interface" and never name one. A URL on any real address,
 * `localhost` and private IPs included, is left alone; a mismatch there is configuration to
 * respect, not corruption to repair. Same boundary-correction philosophy as
 * `fixCallbackUrlOrigin` in proxy.ts, one layer earlier.
 */
export function correctedRequestUrl(url: string, headers: Headers): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!isUnspecifiedHost(parsed.hostname)) return null;

  // First hop only: a proxy chain appends, and the first entry is the client-facing one. `host`
  // is the fallback for a runtime that didn't fill the forwarded header.
  const forwardedHost =
    headers.get('x-forwarded-host')?.split(',')[0]?.trim() || headers.get('host')?.trim();
  if (!forwardedHost) return null;

  let candidate: URL;
  try {
    candidate = new URL(`http://${forwardedHost}`);
  } catch {
    return null;
  }
  // A forwarded host that is itself unspecified proves nothing knew the real name. Leave the URL
  // alone rather than swap one unusable origin for another.
  if (isUnspecifiedHost(candidate.hostname)) return null;

  const proto = headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  if (proto === 'https') parsed.protocol = 'https:';
  else if (proto === 'http') parsed.protocol = 'http:';
  parsed.hostname = candidate.hostname;
  parsed.port = candidate.port;
  return parsed.toString();
}

/**
 * The request to hand Auth.js's route handlers: same request, origin corrected when (and only
 * when) `correctedRequestUrl` found something to correct. A real NextRequest, not a plain
 * Request, because next-auth's own handlers read `req.nextUrl` on the AUTH_URL-configured path.
 * Construction from the original request carries method, headers and body across.
 */
export function withCorrectedOrigin(req: NextRequest): NextRequest {
  const corrected = correctedRequestUrl(req.url, req.headers);
  return corrected ? new NextRequest(corrected, req) : req;
}

function isUnspecifiedHost(hostname: string): boolean {
  return hostname === '0.0.0.0' || hostname === '[::]' || hostname === '::';
}
