import { ResourceManagementClient } from '@azure/arm-resources';
import type { TenantContext } from '../types.js';
import { AZURE_CALL_TIMEOUT_MS, AZURE_LIST_TIMEOUT_MS } from '../net/fetch-retry.js';

const TOP_LEVEL = new Set(['id', 'name', 'type', 'kind', 'location', 'resourceGroup', 'subscriptionId', 'tenantId', 'tags', 'sku', 'plan', 'identity', 'zones', 'managedBy']);

/**
 * Returns every property path available for a resource type using the ARM provider
 * aliases API — the same schema source Azure Policy itself uses.
 * Paths are in ARG dot-notation (e.g. "properties.hardwareProfile.vmSize").
 */
export async function getResourceTypeFields(
  resourceType: string,
  ctx: TenantContext,
): Promise<string[]> {
  const lower = resourceType.toLowerCase().trim();
  const slash = lower.indexOf('/');
  if (slash === -1) return [];

  const namespace = lower.slice(0, slash);      // microsoft.compute
  const typeName  = lower.slice(slash + 1);     // virtualmachines

  const subId = ctx.subscriptionIds[0];
  if (!subId) return [];

  const client = new ResourceManagementClient(ctx.credential, subId);
  const provider = await client.providers.get(namespace, {
    expand: 'resourceTypes/aliases',
    abortSignal: AbortSignal.timeout(AZURE_CALL_TIMEOUT_MS),
  });

  const rt = provider.resourceTypes?.find(
    r => r.resourceType?.toLowerCase() === typeName,
  );
  if (!rt?.aliases?.length) return [];

  const fields = new Set<string>(TOP_LEVEL);

  for (const alias of rt.aliases) {
    // Collect all versioned paths — they may differ slightly across API versions
    for (const p of alias.paths ?? []) {
      if (p.path) fields.add(p.path);
    }
    // defaultPath is the canonical path used when no API version matches
    if (alias.defaultPath) fields.add(alias.defaultPath);
  }

  return [...fields].sort();
}

/**
 * Returns every resource type registered by all providers in the tenant
 * (e.g. "microsoft.compute/virtualmachines"). Includes sub-resources.
 * Uses the ARM providers list, so types appear even before any resources are deployed.
 */
export async function getAllResourceTypes(ctx: TenantContext): Promise<string[]> {
  const subId = ctx.subscriptionIds[0];
  if (!subId) return [];

  const client = new ResourceManagementClient(ctx.credential, subId);
  const types: string[] = [];

  for await (const provider of client.providers.list({
    abortSignal: AbortSignal.timeout(AZURE_LIST_TIMEOUT_MS),
  })) {
    const ns = provider.namespace?.toLowerCase();
    if (!ns) continue;
    for (const rt of provider.resourceTypes ?? []) {
      const t = rt.resourceType?.toLowerCase();
      if (t) types.push(`${ns}/${t}`);
    }
  }

  return types.sort();
}
