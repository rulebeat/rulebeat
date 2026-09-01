import NextAuth, { type NextAuthConfig } from 'next-auth';
import { authConfig } from './auth.config';
import { buildProviders, resolveSignInConfig } from '@/lib/sign-in-config';

interface EntraProfile {
  tid?: string;
  oid?: string;
  name?: string;
  email?: string;
  preferred_username?: string;
}

/**
 * Named and exported (rather than an inline arrow passed straight to `NextAuth()`) purely so
 * `tests/unit/auth-config.test.ts` can call it directly — the function-form config this needs (to
 * `await` a DB-backed provider list) can't otherwise be inspected without booting the whole
 * Auth.js request pipeline.
 */
export async function buildAuthConfig(): Promise<NextAuthConfig> {
  return {
    ...authConfig,
    providers: await buildProviders(),
    callbacks: {
      ...authConfig.callbacks,
      async signIn({ user, account, profile }) {
        // Other providers (the local Credentials provider) handle their own validation inside
        // authorize() and normalize user.id there — this branch only concerns Entra.
        if (account?.provider !== 'microsoft-entra-id') return true;

        // Resolved fresh rather than read off a module-scope constant: the tenant this install
        // trusts can now change at runtime (Settings → Sign-in), not just at process start.
        const resolved = await resolveSignInConfig();
        if (!resolved) return false;

        const p = profile as EntraProfile | undefined;
        if (p?.tid !== resolved.tenantId) return false;
        // Without an object id there's no stable key for the local role assignment, so there is
        // no safe way to decide what this person may do.
        if (!p?.oid) return false;

        // Dynamic import keeps the SQLite-backed modules out of any code path that doesn't need
        // them — proxy.ts no longer imports this file at all, but there's no reason for the
        // database to load any earlier than the moment a sign-in actually needs it.
        const { provisionUser } = await import('@/lib/provision-user');
        const email = user.email ?? p.email ?? p.preferred_username ?? '';
        const provisioned = await provisionUser({ oid: p.oid, email, name: user.name ?? p.name });
        if (!provisioned) return false;

        // A stored-but-unverified row proves itself here: a real OAuth round trip is a strictly
        // stronger check than any probe could run ahead of time (it exercises the redirect URI,
        // the client secret and the tenant all at once). Env-managed config has no row to flip.
        if (resolved.source === 'stored' && resolved.storedProviderId) {
          const { markSsoProviderVerified } = await import('@/lib/db/sso-providers');
          await markSsoProviderVerified(resolved.storedProviderId);
        }

        // Normalize to our own users.id. The Entra provider otherwise leaves user.id as
        // profile.sub, which is not a row in our users table — jwt() below reads this off `user`
        // unconditionally, so this is the one place that has to know which provider is which.
        user.id = provisioned.id;
        return true;
      },
      async jwt({ token, user, account }) {
        // `user` is only present on the initial sign-in; afterwards the value rides the token.
        // Every provider is responsible for setting user.id to our own users.id before this runs
        // (Entra via the signIn callback above, Credentials via its own authorize()) — that's
        // what makes this one line work for both without this callback knowing which provider ran.
        if (account && user?.id) {
          token.uid = user.id;
          // Read fresh rather than trusting anything on `user`/`account` — neither provider object
          // carries our own sessionEpoch column, and a stale value here would defeat the whole
          // point of spec 020's invalidation mechanism.
          const { getUser } = await import('@/lib/db/users');
          token.epoch = (await getUser(user.id))?.sessionEpoch ?? 0;
        }
        return token;
      },
    },
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth(buildAuthConfig);
