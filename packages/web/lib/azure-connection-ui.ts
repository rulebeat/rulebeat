import type { AzureConnectionStatus, AzureCredentialSource } from './azure-credential';

/**
 * How the onboarding Connect step and the Settings card read an `AzureConnectionStatus`.
 *
 * Kept apart from `lib/azure-credential.ts` on purpose: that module pulls in the Azure SDK, and
 * these two functions are consumed by client components, which may only import its types. This
 * file imports nothing at runtime, so it is safe on both sides, and it is the unit-test seam for
 * logic that would otherwise live inside a component's render body (the codebase has no
 * component-rendering test layer; see tests/unit/toggle-set.test.ts for the same pattern).
 *
 * "Ambient" means there is nothing for a person to type: the credential is either supplied by
 * the environment (`managedByEnv`) or resolved from the host itself, a managed identity in Azure
 * or an `az login` session locally (`source: 'chain'`). Before this distinction existed the
 * Connect step keyed on `managedByEnv` alone, so a managed-identity install was shown the
 * service principal form, could never verify it, and could never reach the wizard's Finish
 * button (issue #89).
 */
export function credentialIsAmbient(status: Pick<AzureConnectionStatus, 'managedByEnv' | 'source'>): boolean {
  return status.managedByEnv || status.source === 'chain';
}

const ENV_SOURCE_LABEL: Record<AzureCredentialSource, string> = {
  'env-federated': 'Workload identity federation',
  'env-certificate': 'A service principal certificate',
  'env-secret-file': 'A service principal secret (mounted file)',
  'env-secret': 'A service principal secret (environment variable)',
  stored: 'A credential stored in RuleBeat',
  chain: 'Managed identity or Azure CLI sign-in',
};

/** The one sentence the read-only panel shows for an ambient credential. */
export function ambientCredentialCopy(status: Pick<AzureConnectionStatus, 'managedByEnv' | 'source'>): string {
  if (status.source === 'chain' && !status.managedByEnv) {
    return 'No service principal is configured, so RuleBeat scans as this host\'s managed identity, '
      + 'or as your Azure CLI sign-in when running locally. There is nothing to enter: press Verify '
      + 'to confirm it reaches your subscriptions.';
  }
  return `${ENV_SOURCE_LABEL[status.source ?? 'chain']} is supplying this credential from the environment.`;
}
