import { headers } from 'next/headers';

/**
 * The absolute origin `opengraph-image.png` and friends are resolved against.
 *
 * Next serves those files at a relative path, so a link preview in Teams or Slack needs a base to
 * turn them into fetchable URLs. Leaving it unset does not disable the feature, it bakes
 * `http://localhost:3000` into every install's meta tags.
 *
 * Resolution matches the sign-in redirect, and is documented the same way in
 * docs/public/configure.md: `AUTH_URL` when it is set, otherwise the origin the request arrived
 * on, which is right for a typical single-tenant self-host.
 *
 * That reuses the forwarded host RuleBeat already trusts, but this is a new place to spend that
 * trust, so be exact about the blast radius: a spoofed host lands in `<meta>` tags and nowhere
 * else. Nothing here signs, redirects, or authorises, so the worst outcome is a link preview
 * pointing at the wrong origin. An install behind a proxy that does not set the forwarded headers
 * correctly should set the public URL, which is what that setting is for.
 *
 * `process.env.AUTH_URL` is read as a literal on purpose: a dynamic `process.env[name]` lookup is
 * not inlined by the bundler, which has already caused one severe auth bug here
 * (lib/auth-secret.ts). It also always reflects a URL saved in Settings, because
 * `syncAuthUrlMirror` keeps it in step on save and on clear.
 */
export async function resolveMetadataBase(): Promise<URL | undefined> {
  const configured = process.env.AUTH_URL?.trim();
  if (configured) {
    try {
      return new URL(configured);
    } catch {
      // Misconfigured value: fall through to the request rather than failing the render.
    }
  }

  const requestHeaders = await headers();
  const host = requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host');
  if (!host) return undefined;

  const proto = requestHeaders.get('x-forwarded-proto') ?? 'http';
  try {
    return new URL(`${proto}://${host}`);
  } catch {
    // A header can carry anything. Undefined means Next falls back to its own default, which is
    // a wrong preview URL rather than a failed page render.
    return undefined;
  }
}
