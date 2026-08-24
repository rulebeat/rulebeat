import Credentials from 'next-auth/providers/credentials';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';
import { fetchWithRetry } from '@rulebeat/core';
import { getMeta, setMeta, deleteMeta } from '@/lib/db/meta';
import {
  getStoredSsoProvider,
  getStoredSsoProviderSummary,
  type SsoProviderSummary,
} from '@/lib/db/sso-providers';
import { getActiveAzureCredentialSummary, type AzureCredentialSummary } from '@/lib/db/azure-credentials';
import { readSecretFileTrimmed } from '@/lib/secret-file';

/**
 * The single place RuleBeat decides how someone signs in — the sign-in equivalent of
 * `lib/azure-credential.ts`. Everything that builds a provider list or displays sign-in status
 * goes through here.
 *
 * Resolution order, same reasoning as the Azure credential resolver: environment variables always
 * win, because an IaC or Marketplace deployment must arrive fully configured and never show a
 * setup screen. Below that, whatever is saved in Settings → Sign-in. Below that, local accounts
 * only — RuleBeat is never unusable just because nobody has configured SSO yet.
 */

export type LocalSignInPolicy = 'always' | 'break-glass' | 'disabled';

const LOCAL_POLICY_KEY = 'local-signin-policy';
const PUBLIC_URL_KEY = 'public-url';

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function isLocalSignInPolicy(value: unknown): value is LocalSignInPolicy {
  return value === 'always' || value === 'break-glass' || value === 'disabled';
}

export function getLocalSignInPolicy(): LocalSignInPolicy {
  const stored = getMeta(LOCAL_POLICY_KEY);
  return isLocalSignInPolicy(stored) ? stored : 'always';
}

export function setLocalSignInPolicy(policy: LocalSignInPolicy): void {
  setMeta(LOCAL_POLICY_KEY, policy);
}

/** The URL this install is reachable at, for `AUTH_URL`/redirect-URI display. Null = not set. */
export function getPublicUrl(): string | null {
  return getMeta(PUBLIC_URL_KEY);
}

export function setPublicUrl(url: string | null): void {
  const trimmed = url?.trim();
  if (trimmed) setMeta(PUBLIC_URL_KEY, trimmed);
  else deleteMeta(PUBLIC_URL_KEY);
}

/* next-auth reads the public URL from `process.env.AUTH_URL`, so a URL configured in Settings has
 * to be mirrored into that variable to have any effect. `OPERATOR_AUTH_URL` is whatever the
 * environment itself supplied, captured once when this module is first evaluated — which happens
 * inside instrumentation.ts's boot bootstrap, before anything writes the mirror. An operator's own
 * AUTH_URL is therefore still the value that wins, unchanged.
 *
 * Written as the literal `process.env.AUTH_URL`. A dynamic `process.env[name]` lookup is not
 * inlined by the bundler, which has already caused one severe auth bug here (lib/auth-secret.ts). */
const OPERATOR_AUTH_URL = process.env.AUTH_URL?.trim() || undefined;

/**
 * Point `AUTH_URL` at the URL just saved in Settings, or clear it when the setting was cleared.
 *
 * Both directions matter. Boot and the save handler used to write the mirror only while it was
 * empty, so the *second* save kept emitting the first URL and clearing the field kept emitting the
 * last one, in both cases until the next restart — while the Settings copy promises the change
 * takes effect immediately. A no-op when the operator set AUTH_URL themselves.
 */
export function syncAuthUrlMirror(url: string | null): void {
  if (OPERATOR_AUTH_URL) return;
  const trimmed = url?.trim();
  if (trimmed) process.env.AUTH_URL = trimmed;
  else delete process.env.AUTH_URL;
}

// Re-exported for anything already importing it from here — the definition itself lives in
// `redirect-uri.ts` because that file has no server-only imports and the client-side settings
// screen needs the exact same string logic to compute what it displays.
export { redirectUriFor } from './redirect-uri';

interface EnvSignInConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

/**
 * IDs checked before the secret is resolved, same order as `azure-credential.ts`'s
 * `envCredentialSource()` — a `_FILE` (or plain) secret var left set on a host where Entra sign-in
 * isn't otherwise configured is never read and can never throw for an irrelevant setting.
 *
 * `AUTH_MICROSOFT_ENTRA_ID_SECRET_FILE` wins over `AUTH_MICROSOFT_ENTRA_ID_SECRET` when both are
 * set. Unlike `auth-secret.ts`/`secret-box.ts`, nothing here is cached — this function already runs
 * fresh on every call, so a `_FILE`'s contents changing takes effect on the very next sign-in.
 */
function envSignInConfig(): EnvSignInConfig | null {
  const tenantId = env('AUTH_MICROSOFT_ENTRA_ID_TENANT_ID');
  const clientId = env('AUTH_MICROSOFT_ENTRA_ID_ID');
  if (!tenantId || !clientId) return null;

  const secretFile = env('AUTH_MICROSOFT_ENTRA_ID_SECRET_FILE');
  const clientSecret = secretFile
    ? readSecretFileTrimmed(secretFile, 'AUTH_MICROSOFT_ENTRA_ID_SECRET_FILE')
    : env('AUTH_MICROSOFT_ENTRA_ID_SECRET');
  if (!clientSecret) return null;

  return { tenantId, clientId, clientSecret };
}

export interface ResolvedSignInConfig extends EnvSignInConfig {
  source: 'env' | 'stored';
  storedProviderId?: string;
}

/**
 * Env wins over the stored row, exactly like `resolveAzureCredential` — and for the identical
 * reason: a provider built from stored values silently ignores env if both are somehow present
 * (Auth.js's own env-var handling applies with `??=`), so precedence has to be enforced here.
 */
export function resolveSignInConfig(): ResolvedSignInConfig | null {
  const fromEnv = envSignInConfig();
  if (fromEnv) return { ...fromEnv, source: 'env' };

  const stored = getStoredSsoProvider();
  if (stored) {
    return {
      tenantId: stored.tenantId,
      clientId: stored.clientId,
      clientSecret: stored.clientSecret,
      source: 'stored',
      storedProviderId: stored.id,
    };
  }

  return null;
}

export interface SignInStatus {
  /** True once *something* will be tried for SSO. Local accounts are always available regardless. */
  configured: boolean;
  managedByEnv: boolean;
  tenantId: string | null;
  clientId: string | null;
  stored: SsoProviderSummary | null;
  /** True for env (assumed correct by the operator) or once a stored row has a real sign-in behind it. */
  isActive: boolean;
  message: string;
  localSignInPolicy: LocalSignInPolicy;
  publicUrl: string | null;
  /** The Azure connection's app registration, if one is configured and reusable for sign-in too. */
  azureConnection: AzureCredentialSummary | null;
}

/** Read-only description of sign-in configuration, for the settings screen and /signin. */
export function getSignInStatus(): SignInStatus {
  const stored = getStoredSsoProviderSummary();
  const fromEnv = envSignInConfig();
  const localSignInPolicy = getLocalSignInPolicy();
  const publicUrl = getPublicUrl();
  const azureConnection = getActiveAzureCredentialSummary();

  if (fromEnv) {
    return {
      configured: true,
      managedByEnv: true,
      tenantId: fromEnv.tenantId,
      clientId: fromEnv.clientId,
      stored,
      isActive: true,
      message: 'Microsoft sign-in is configured by this deployment’s environment variables.',
      localSignInPolicy,
      publicUrl,
      azureConnection,
    };
  }

  if (stored && !stored.secretUnreadable) {
    return {
      configured: true,
      managedByEnv: false,
      tenantId: stored.tenantId,
      clientId: stored.clientId,
      stored,
      isActive: stored.isActive,
      message: stored.isActive
        ? 'Microsoft sign-in is configured and verified.'
        : 'Microsoft sign-in is configured and already appears on the sign-in page. Nobody has '
          + 'used it yet, so it is not confirmed working end to end.',
      localSignInPolicy,
      publicUrl,
      azureConnection,
    };
  }

  if (stored?.secretUnreadable) {
    return {
      configured: false,
      managedByEnv: false,
      tenantId: stored.tenantId,
      clientId: stored.clientId,
      stored,
      isActive: false,
      message: 'The stored client secret can no longer be read — the encryption key changed or the '
        + 'data volume was replaced. Enter the secret again to restore Microsoft sign-in.',
      localSignInPolicy,
      publicUrl,
      azureConnection,
    };
  }

  return {
    configured: false,
    managedByEnv: false,
    tenantId: null,
    clientId: null,
    stored: null,
    isActive: false,
    message: 'No SSO provider is configured. Sign in with a local account, or connect Microsoft '
      + 'Entra ID below.',
    localSignInPolicy,
    publicUrl,
    azureConnection,
  };
}

/**
 * A cheap, unauthenticated reachability check — fetches the tenant's OIDC discovery document.
 * Catches a typo'd tenant instantly. Deliberately does NOT prove the client id/secret or redirect
 * URI are correct, and is labelled as "tenant reachable" everywhere it's shown, not "verified".
 */
export async function probeTenant(tenantId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetchWithRetry(
      `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/v2.0/.well-known/openid-configuration`,
    );
    if (!res.ok) {
      return { ok: false, error: 'That tenant ID doesn’t exist, or Microsoft Entra ID couldn’t be reached for it.' };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'Could not reach Microsoft Entra ID from this host. Check outbound network access.' };
  }
}

/**
 * The local-account sign-in path — break-glass access that doesn't depend on Entra being
 * reachable or correctly configured. `authorize()` returns the *same* null for "no such account"
 * and "wrong password", and burns a dummy password verification on the unknown-account path, so
 * response timing can't be used to enumerate which emails exist.
 *
 * Refuses outright when the local policy is `disabled`, unless the host sets
 * `RULEBEAT_FORCE_LOCAL_SIGNIN=true` — the escape hatch for an SSO misconfiguration locking
 * everyone out, since `RULEBEAT_INITIAL_ADMIN` only grants a role, not a password.
 */
export async function authorizeLocalAccount(credentials: Partial<Record<string, unknown>>) {
  if (getLocalSignInPolicy() === 'disabled' && env('RULEBEAT_FORCE_LOCAL_SIGNIN') !== 'true') {
    return null;
  }

  const email = typeof credentials.email === 'string' ? credentials.email.trim().toLowerCase() : '';
  const password = typeof credentials.password === 'string' ? credentials.password : '';
  if (!email || !password) return null;

  const [{ getUserByEmail, touchLastSeen }, localAccounts, { verifyPassword, verifyDummyPassword }, { writeAudit, logAuthEvent }] =
    await Promise.all([
      import('@/lib/db/users'),
      import('@/lib/db/local-accounts'),
      import('@/lib/password'),
      import('@/lib/db/audit'),
    ]);

  const user = getUserByEmail(email);
  const account = user ? localAccounts.getLocalAccount(user.id) : null;

  // Unbounded and attacker- or accident-reachable: a nonexistent email, or a real user with no
  // local password (e.g. an SSO-only user on the local form). Neither is a bounded, real account
  // this history can be attributed to — logged, not persisted (spec 022).
  if (!user || !account) {
    await verifyDummyPassword(password);
    logAuthEvent(`Failed local sign-in attempt for ${email}`, { reason: 'unknown-account' });
    return null;
  }

  // Also unbounded: isLockedOut() is checked before any password verification, so every repeated
  // request against an already-locked account writes here, not just the one that caused the
  // lockout. Logged, not persisted — the lockout-causing attempt itself is still recorded below,
  // in the wrong-password branch (spec 022).
  if (localAccounts.isLockedOut(account)) {
    logAuthEvent(`${user.email} tried to sign in while locked out from too many failed attempts`);
    return null;
  }

  const valid = await verifyPassword(password, account.passwordHash);
  if (!valid) {
    localAccounts.recordFailedAttempt(user.id);
    writeAudit({
      actor: user,
      action: 'auth.sign_in_failed',
      entityType: 'auth',
      summary: `${user.email} entered the wrong password`,
      details: { reason: 'wrong-password' },
    });
    return null;
  }

  localAccounts.clearFailedAttempts(user.id);
  touchLastSeen(user.id);
  const { writeSignInAudit } = await import('@/lib/provision-user');
  writeSignInAudit(user);

  return { id: user.id, email: user.email, name: user.name ?? undefined };
}

/**
 * The full provider list for `auth.ts`. Local accounts (Credentials) are always present — they're
 * how you reach the console to configure SSO in the first place — Microsoft Entra ID is added only
 * once something resolves.
 */
export async function buildProviders() {
  const providers: Array<ReturnType<typeof Credentials> | ReturnType<typeof MicrosoftEntraID>> = [
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: authorizeLocalAccount,
    }),
  ];

  const resolved = resolveSignInConfig();
  if (resolved) {
    providers.push(MicrosoftEntraID({
      clientId: resolved.clientId,
      clientSecret: resolved.clientSecret,
      issuer: `https://login.microsoftonline.com/${resolved.tenantId}/v2.0`,
    }));
  }

  return providers;
}
