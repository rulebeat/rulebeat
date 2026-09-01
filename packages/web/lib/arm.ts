import type { TokenCredential } from '@azure/identity';
import { fetchWithRetry } from '@rulebeat/core';
import { getAzureCredential, getAzureToken, resolveAzureCredential } from '@/lib/azure-credential';

/**
 * ARM helpers for the routes that call the management API directly rather than through a
 * `TenantContext`.
 *
 * These deliberately take no tenant id: which identity and which tenant RuleBeat uses is decided in
 * exactly one place (`lib/azure-credential.ts`). Passing `process.env.AZURE_TENANT_ID` in at each
 * call site — which is what these functions used to do — meant a credential configured through the
 * UI would have been ignored here while working everywhere else.
 */

export function getArmCredential(): Promise<TokenCredential> {
  return getAzureCredential();
}

export function getArmToken(): Promise<string> {
  return getAzureToken('https://management.azure.com/.default');
}

/** The tenant every ARM call in this app is scoped to. */
export async function getArmTenantId(): Promise<string> {
  return (await resolveAzureCredential()).tenantId;
}

export async function armFetch<T>(url: string, token: string): Promise<T> {
  const res = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`ARM ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}
