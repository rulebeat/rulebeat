import type { NextAuthConfig } from 'next-auth';
import { getAuthSecret } from '@/lib/auth-secret';
import { isDemoEnv } from '@/lib/demo-env';

/**
 * The DB-free half of the Auth.js config, shared between `auth.ts` (the full config, with
 * providers and the SQLite-backed `signIn`/`jwt` callbacks) and `proxy.ts` (route protection on
 * every request).
 *
 * `proxy.ts` only ever needs to decode the JWT and check one claim — it has no business opening
 * SQLite at import time to build a provider list it never uses. Splitting the config this way is
 * Auth.js's own documented pattern for exactly this case.
 *
 * No `jwt` callback here: on a session *read* (as opposed to a sign-in) Auth.js calls it with only
 * `{ token }`, and the default passthrough already preserves `token.uid` — adding one here would
 * do nothing but risk drifting from the real one in `auth.ts`. `session` has to live here anyway,
 * since the proxy's `authorized` callback reads `auth.user.uid`, which only exists after `session`
 * copies it off the token.
 */
export const authConfig: NextAuthConfig = {
  providers: [],
  pages: {
    signIn: '/signin',
    error: '/signin',
  },
  // Auth.js defaults to a 30-day session. That's a long window for a tool that reads a customer's
  // whole cloud estate, and it costs us nothing to shorten: the role is resolved from SQLite per
  // request (lib/api-auth.ts), so a demotion already applies immediately — this bounds how long a
  // stolen cookie stays useful, which the live role lookup does not cover.
  session: { strategy: 'jwt', maxAge: 12 * 60 * 60, updateAge: 60 * 60 },
  secret: getAuthSecret(),
  // With a genuinely empty env in production, Auth.js's own default for this is `false` and every
  // request becomes an UntrustedHost error — see the design note in the B1b plan on why this is
  // safe for a single-tenant self-hosted app whose OAuth callback URL is pinned in Entra.
  trustHost: true,
  callbacks: {
    authorized({ auth, request }) {
      // uid (our own users.id) is required, not just any session: a token issued before this
      // claim existed — or a local session with no linked role yet — carries no uid, so the role
      // can't be resolved and every API call would 401 while the user still looked signed in.
      // Treating those as unauthenticated sends them through sign-in once, after which the token
      // carries a uid and everything works.
      if (auth?.user?.uid) return true;

      // Demo mode: let an anonymous GET through with no session at all, so a visitor can browse
      // without signing in first. Only `isDemoEnv()` (the environment variable) is checked here —
      // this file is bundled into the edge/proxy build and can't touch SQLite to check the second
      // gate (lib/demo.ts's `demo-mode-v1` stamp), so it stays deliberately permissive at this
      // layer. That is safe: this callback only decides whether a *page navigation or API request
      // is let through at all*, never what it's allowed to do. The actual read-only enforcement —
      // and the full two-gate check — happens downstream in lib/api-auth.ts's getCurrentUser() and
      // requireRole(), which is where a write actually gets denied. A non-GET (a mutation) falls
      // through to the redirect-to-signin below, same as any other anonymous request.
      return isDemoEnv() && request.method === 'GET';
    },
    async session({ session, token }) {
      session.user.uid = typeof token.uid === 'string' ? token.uid : null;
      session.user.epoch = typeof token.epoch === 'number' ? token.epoch : null;
      return session;
    },
  },
};
