/**
 * Where Entra must send someone back to, for the app registration's Authentication settings.
 *
 * Client-safe on purpose (no server imports) so both `sign-in-section.tsx` and the onboarding
 * Connect step can call it directly instead of duplicating the string template.
 */
export function redirectUriFor(origin: string): string {
  return `${origin.replace(/\/$/, '')}/api/auth/callback/microsoft-entra-id`;
}
