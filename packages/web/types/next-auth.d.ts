import type { DefaultSession } from 'next-auth';

// `uid` is our own `users.id` — a provider-agnostic identifier that works for both an Entra
// sign-in (where `user.id` is the Entra `sub`, not our row) and a local account (which has no
// Entra identity at all). It's carried on the token/session purely as an identifier — the role
// itself is deliberately NOT here, so that changing someone's role takes effect on their very next
// request instead of whenever their token happens to refresh.
// The JWT itself needs no augmentation — Auth.js types it as `Record<string, unknown>`, so
// `token.uid` is readable already; auth.ts narrows it to a string at the point of use.
declare module 'next-auth' {
  interface Session {
    // Stamped at sign-in from users.sessionEpoch (spec 020) and compared against the live DB value
    // in getCurrentUser() — a mismatch means a local-password mutation happened since this token was
    // issued, so the session is treated as signed out even though the JWT itself still verifies.
    user: { uid?: string | null; epoch?: number | null } & DefaultSession['user'];
  }
}
