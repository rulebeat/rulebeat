/**
 * Turns an Entra (AADSTS) error code into something an admin can act on.
 *
 * Lifted out of `lib/azure-credential.ts` (which re-exports this) so Settings → Sign-in can share
 * the same mapping rather than growing a second, drifting copy — AADSTS codes mean the same thing
 * whether they came from the scanning service principal or from an interactive sign-in.
 *
 * This module only maps error *strings* — it never constructs a credential or reads a secret, so
 * it doesn't trip `tests/unit/azure-credential-chokepoint.test.ts` or
 * `tests/unit/password-chokepoint.test.ts`.
 */
export function describeAadstsError(raw: string): string | null {
  if (/AADSTS7000215|invalid_client|Invalid client secret/i.test(raw)) {
    return 'Azure rejected the client secret. Check it was copied from the secret’s Value column, not its Secret ID.';
  }
  if (/AADSTS700016|application with identifier .* was not found/i.test(raw)) {
    return 'No application with that client ID exists in this tenant. Check the client ID and the tenant ID match the same app registration.';
  }
  if (/AADSTS7000222|expired/i.test(raw)) {
    return 'The client secret has expired. Create a new secret on the app registration and enter it here.';
  }
  if (/AADSTS90002|tenant .* not found/i.test(raw)) {
    return 'That tenant ID does not exist. Check for a typo — it should be a GUID.';
  }
  if (/AADSTS50011/i.test(raw)) {
    return 'The redirect URI Azure received doesn’t match what’s registered on the app. Copy the exact redirect URI shown below into the app registration’s Authentication settings.';
  }
  if (/AADSTS50020/i.test(raw)) {
    return 'That account doesn’t belong to the tenant this install is configured for. Sign in with an account from the correct tenant, or update the tenant ID below.';
  }
  return null;
}
