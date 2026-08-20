import { readFileSync } from 'node:fs';
import {
  ClientSecretCredential,
  DefaultAzureCredential,
  EnvironmentCredential,
  WorkloadIdentityCredential,
  type TokenCredential,
} from '@azure/identity';
import {
  AZURE_CALL_TIMEOUT_MS,
  buildTenantContext,
  listAccessibleSubscriptions,
  type TenantContext,
} from '@rulebeat/core';
import {
  getActiveAzureCredential,
  getActiveAzureCredentialSummary,
  type AzureCredentialSummary,
} from '@/lib/db/azure-credentials';
import { describeAadstsError } from '@/lib/entra-errors';
import { isDemoMode } from '@/lib/demo';
import { createScanLogger, type ScanLogContext } from '@/lib/server-logger';
import { resolveLogAnalyticsWorkspaceId } from '@/lib/log-analytics-workspace';

export { describeAadstsError } from '@/lib/entra-errors';

/**
 * The single place RuleBeat decides which identity it reads Azure with.
 *
 * Everything that touches Azure goes through here — `tests/unit/azure-credential-chokepoint.test.ts`
 * fails the build if any other file constructs a credential directly. That matters because the
 * credential can now come from three different places: a credential resolved in one code path but
 * not another is the kind of bug that looks like "scans work but the schema cache is empty".
 *
 * Resolution order, and why:
 *
 *  1. **Environment variables.** An IaC, Docker or Marketplace deployment must be able to arrive
 *     fully configured and never show a setup screen, so env always wins over anything an admin
 *     typed into the UI. Within the env path the order follows Microsoft's own current guidance —
 *     federated token (keyless) first, then certificate, then client secret last.
 *  2. **The credential stored via the UI**, for the human running `docker compose up` who has no
 *     way to set env vars after the fact.
 *  3. **`DefaultAzureCredential`**, which covers Managed Identity in Azure and `az login` locally.
 *     This is the best posture of the three and needs no configuration at all — it is last only
 *     because it is the one that can't be chosen explicitly.
 *
 * Note that step 1 constructs a *specific* credential rather than letting `DefaultAzureCredential`
 * discover the same variables. The chain would silently fall through to the developer's `az login`
 * identity when a service principal is misconfigured, which means a broken deployment appears to
 * work locally and scans as the wrong principal. An explicitly configured credential should fail
 * loudly instead.
 */

export type AzureCredentialSource =
  | 'env-federated'
  | 'env-certificate'
  | 'env-secret-file'
  | 'env-secret'
  | 'stored'
  | 'chain';

export const CREDENTIAL_SOURCE_LABELS: Record<AzureCredentialSource, string> = {
  'env-federated': 'Workload identity federation (environment)',
  'env-certificate': 'Service principal certificate (environment)',
  'env-secret-file': 'Service principal secret (mounted file)',
  'env-secret': 'Service principal secret (environment variable)',
  stored: 'Service principal secret (entered in RuleBeat)',
  chain: 'Managed identity or Azure CLI sign-in',
};

export interface ResolvedAzureCredential {
  credential: TokenCredential;
  tenantId: string;
  source: AzureCredentialSource;
  /** Set only for `source: 'stored'`, so a successful verification can be recorded against the row. */
  storedCredentialId?: string;
}

/**
 * Thrown when there is no credential to try at all. Distinct from an authentication failure: this
 * one is answerable by the admin from the setup screen, so the API layer is allowed to show its
 * message rather than routing it through `serverError`.
 */
export class AzureNotConfiguredError extends Error {
  readonly code = 'azure_not_configured';

  constructor(message: string) {
    super(message);
    this.name = 'AzureNotConfiguredError';
  }
}

const NOT_CONFIGURED_MESSAGE = [
  'RuleBeat has no Azure credential to scan with.',
  'Connect Azure in Settings, or set AZURE_TENANT_ID and a service principal in the environment.',
].join(' ');

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Reads a secret out of a mounted file (`AZURE_CLIENT_SECRET_FILE`).
 *
 * The `*_FILE` convention comes from the official Postgres/MySQL images and is what Docker secrets,
 * Kubernetes secrets and the Key Vault CSI driver all mount into. It exists because an environment
 * variable is a poor place for a secret: it is visible in `docker inspect` to anyone in the docker
 * group, is inherited by every child process, and lands in crash dumps and error reporters. A
 * mounted file is readable only by the process and never appears in container metadata.
 *
 * It also rotates without a rebuild — resolution reads the file on each call, so replacing the
 * mounted secret is picked up by the next scan.
 */
export function readSecretFile(path: string): string {
  // `.trim()` is load-bearing. `echo "secret" > file` appends a newline, Entra rejects the value,
  // and the resulting error says only "invalid client secret" — which sends people looking at the
  // app registration rather than at the trailing byte.
  const contents = readFileSync(path, 'utf8').trim();
  if (!contents) throw new AzureNotConfiguredError(`AZURE_CLIENT_SECRET_FILE points at ${path}, which is empty.`);
  return contents;
}

/**
 * Which environment-variable credential, if any, is fully specified.
 *
 * Ordered by how well the secret is protected, strongest first: no secret at all (federated), a
 * certificate, a secret mounted as a file, and last a secret sitting in an environment variable.
 */
function envCredentialSource(): AzureCredentialSource | null {
  const tenantId = env('AZURE_TENANT_ID');
  const clientId = env('AZURE_CLIENT_ID');
  if (!tenantId || !clientId) return null;

  if (env('AZURE_FEDERATED_TOKEN_FILE')) return 'env-federated';
  if (env('AZURE_CLIENT_CERTIFICATE_PATH')) return 'env-certificate';
  if (env('AZURE_CLIENT_SECRET_FILE')) return 'env-secret-file';
  if (env('AZURE_CLIENT_SECRET')) return 'env-secret';
  return null;
}

const DEMO_MODE_MESSAGE =
  'This is a demo instance. It never connects to a real Azure tenant — every scan runs against '
  + 'synthetic data baked in ahead of time.';

export function resolveAzureCredential(): ResolvedAzureCredential {
  // The runtime half of the kill switch: every live Azure/Graph path in the app funnels through
  // this one function (tests/unit/azure-credential-chokepoint.test.ts proves no other file builds
  // a credential directly), so one branch here is provably total. It runs ahead of every other
  // source, including env — a demo deployment that also happens to carry a real service principal
  // in its environment must still never use it. AzureNotConfiguredError is deliberately reused
  // rather than a new error type: it is already the one type the API layer is allowed to surface
  // verbatim to the browser instead of routing through serverError().
  if (isDemoMode()) throw new AzureNotConfiguredError(DEMO_MODE_MESSAGE);

  const envSource = envCredentialSource();

  if (envSource) {
    const tenantId = env('AZURE_TENANT_ID')!;
    const clientId = env('AZURE_CLIENT_ID')!;

    if (envSource === 'env-federated') {
      return {
        source: envSource,
        tenantId,
        credential: new WorkloadIdentityCredential({
          tenantId,
          clientId,
          tokenFilePath: env('AZURE_FEDERATED_TOKEN_FILE')!,
        }),
      };
    }

    if (envSource === 'env-secret-file') {
      return {
        source: envSource,
        tenantId,
        credential: new ClientSecretCredential(
          tenantId, clientId, readSecretFile(env('AZURE_CLIENT_SECRET_FILE')!),
        ),
      };
    }

    // EnvironmentCredential reads AZURE_CLIENT_SECRET / AZURE_CLIENT_CERTIFICATE_PATH itself, and
    // handles the certificate password variant too — no reason to re-implement that here.
    return { source: envSource, tenantId, credential: new EnvironmentCredential() };
  }

  const stored = getActiveAzureCredential();
  if (stored) {
    return {
      source: 'stored',
      tenantId: stored.tenantId,
      storedCredentialId: stored.id,
      credential: new ClientSecretCredential(stored.tenantId, stored.clientId, stored.clientSecret),
    };
  }

  // Nothing explicit. Fall back to the ambient identity — but a tenant id is still required, since
  // every ARG query and the sign-in configuration are both scoped to one.
  const tenantId = env('AZURE_TENANT_ID') ?? getActiveAzureCredentialSummary()?.tenantId;
  if (!tenantId) throw new AzureNotConfiguredError(NOT_CONFIGURED_MESSAGE);

  return { source: 'chain', tenantId, credential: new DefaultAzureCredential({ tenantId }) };
}

/**
 * A credential built from values that have not been stored yet — the "test this before I save it"
 * path in Settings → Azure connection.
 *
 * It lives here rather than in the route so that constructing an Azure credential anywhere outside
 * this module stays banned outright, with no exceptions to argue about. An allowlist of two routes
 * would be the first crack in a rule whose whole value is being absolute.
 */
export function credentialFromClientSecret(
  tenantId: string,
  clientId: string,
  clientSecret: string,
): TokenCredential {
  return new ClientSecretCredential(tenantId, clientId, clientSecret);
}

/** The credential alone, for the ARM routes that don't need a full tenant context. */
export function getAzureCredential(): TokenCredential {
  return resolveAzureCredential().credential;
}

export async function getAzureToken(scope = 'https://management.azure.com/.default'): Promise<string> {
  const token = await getAzureCredential().getToken(scope, {
    abortSignal: AbortSignal.timeout(AZURE_CALL_TIMEOUT_MS),
  });
  if (!token) throw new Error('Azure returned no token for the configured credential.');
  return token.token;
}

/**
 * A `TenantContext` built from the resolved credential. Every scan, schema fetch and KQL validation
 * in the web app starts here rather than calling `buildTenantContext()` with no arguments, which
 * would build its own `DefaultAzureCredential` and ignore both the env and stored paths.
 *
 * `logContext` (e.g. `{ runId }`) wires a real stdout logger in instead of `buildTenantContext()`'s
 * silent no-op default — every caller gets real logging, callers with no run to attach (onboarding,
 * preflight, schema routes, KQL validation) just don't have a `runId` on their lines.
 */
export async function createTenantContext(logContext?: ScanLogContext): Promise<TenantContext> {
  const { credential, tenantId } = resolveAzureCredential();
  const logAnalyticsWorkspaceId = resolveLogAnalyticsWorkspaceId()?.workspaceId;
  return buildTenantContext({ credential, tenantId, log: createScanLogger(logContext), logAnalyticsWorkspaceId });
}

export interface AzureConnectionStatus {
  /** True when *something* will be tried. It may still fail to authenticate. */
  configured: boolean;
  source: AzureCredentialSource | null;
  sourceLabel: string | null;
  tenantId: string | null;
  clientId: string | null;
  /**
   * True when environment variables are supplying the credential, which means the stored one is
   * inert. The UI disables the form and says so — an admin editing a field that has no effect is
   * worse than not offering the field.
   */
  managedByEnv: boolean;
  stored: AzureCredentialSummary | null;
  message: string;
}

/** Read-only description of the current connection, for the settings screen and diagnostics. */
export function getAzureConnectionStatus(): AzureConnectionStatus {
  const stored = getActiveAzureCredentialSummary();
  const envSource = envCredentialSource();

  if (envSource) {
    return {
      configured: true,
      source: envSource,
      sourceLabel: CREDENTIAL_SOURCE_LABELS[envSource],
      tenantId: env('AZURE_TENANT_ID') ?? null,
      clientId: env('AZURE_CLIENT_ID') ?? null,
      managedByEnv: true,
      stored,
      // The nudge only appears for the one option that keeps a bearer secret in a variable, where
      // it's actionable. Saying it on every card would train people to ignore it.
      message: envSource === 'env-secret'
        ? 'Azure credentials come from this deployment’s environment variables. A secret held in a '
          + 'variable is the weakest supported option — a managed identity, a federated token or a '
          + 'mounted secret file all avoid storing one.'
        : 'Azure credentials come from this deployment’s environment variables.',
    };
  }

  if (stored && !stored.secretUnreadable) {
    return {
      configured: true,
      source: 'stored',
      sourceLabel: CREDENTIAL_SOURCE_LABELS.stored,
      tenantId: stored.tenantId,
      clientId: stored.clientId,
      managedByEnv: false,
      stored,
      message: 'Scanning with the service principal configured here.',
    };
  }

  if (stored?.secretUnreadable) {
    return {
      configured: false,
      source: null,
      sourceLabel: null,
      tenantId: stored.tenantId,
      clientId: stored.clientId,
      managedByEnv: false,
      stored,
      message:
        'The stored client secret can no longer be read — the encryption key changed or the data '
        + 'volume was replaced. Enter the secret again to restore scanning.',
    };
  }

  const tenantId = env('AZURE_TENANT_ID') ?? null;
  if (tenantId) {
    return {
      configured: true,
      source: 'chain',
      sourceLabel: CREDENTIAL_SOURCE_LABELS.chain,
      tenantId,
      clientId: null,
      managedByEnv: false,
      stored,
      message:
        'No service principal is configured. RuleBeat will use a managed identity in Azure, or your '
        + '`az login` session when running locally.',
    };
  }

  return {
    configured: false,
    source: null,
    sourceLabel: null,
    tenantId: null,
    clientId: null,
    managedByEnv: false,
    stored,
    message: NOT_CONFIGURED_MESSAGE,
  };
}

export type VerifyResult =
  | { ok: true; subscriptionCount: number }
  | { ok: false; error: string };

/**
 * The zero-subscriptions message, shared verbatim with `lib/preflight.ts`'s `subscriptions` check —
 * both describe the exact same failure (authenticated, no Reader assignment anywhere) and must never
 * drift into two different phrasings of it.
 */
export const NO_SUBSCRIPTIONS_MESSAGE =
  'Signed in successfully, but this identity can’t see any subscriptions. '
  + 'Assign it the Reader role on the subscriptions or management groups you want scanned.';

/**
 * Proves a credential actually works, by listing the subscriptions it can see.
 *
 * Run before persisting anything: a saved credential that has never worked is the worst state to
 * leave an install in, because nothing surfaces the problem until the first scheduled scan returns
 * nothing at 3am. Zero visible subscriptions is treated as a failure for the same reason — the
 * credential authenticated but has no Reader assignment, so it cannot do the product's only job.
 */
export async function verifyAzureCredential(credential: TokenCredential): Promise<VerifyResult> {
  try {
    const subscriptionIds = await listAccessibleSubscriptions(credential);
    if (subscriptionIds.length === 0) {
      return { ok: false, error: NO_SUBSCRIPTIONS_MESSAGE };
    }
    return { ok: true, subscriptionCount: subscriptionIds.length };
  } catch (err) {
    console.error('[RuleBeat] Azure credential verification failed:', err);
    return { ok: false, error: describeCredentialFailure(err) };
  }
}

/**
 * Turns an Azure authentication failure into something an admin can act on.
 *
 * The raw error is never returned (it carries tenant ids, correlation ids and the list of identity
 * sources tried — see lib/api-error.ts), but "check the server logs" is a poor answer for a form the
 * admin is filling in right now, so the common causes get named explicitly.
 */
export function describeCredentialFailure(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  const aadsts = describeAadstsError(raw);
  if (aadsts) return aadsts;

  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo/i.test(raw)) {
    return 'Could not reach Azure from this host. Check outbound network access and any proxy settings.';
  }
  return 'Azure rejected the credential. Check the RuleBeat server logs for the full error.';
}
