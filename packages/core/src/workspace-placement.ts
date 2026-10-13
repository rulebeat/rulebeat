import { extractAzureErrorMessage } from './errors.js';
import type { TenantContext } from './types.js';

/** The subscription and resource group the configured Log Analytics workspace sits in. */
export interface WorkspacePlacement {
  subscriptionId: string;
  resourceGroup?: string;
}

/**
 * Finds the subscription and resource group of the Log Analytics workspace `ctx` is configured for,
 * by asking Resource Graph for the workspace whose customer id it is. One Resource Graph query at
 * most, and none when no workspace is configured.
 *
 * A row is accepted only when its own customer id equals the configured one, so a query that
 * answers with something else (a fake that returns the same rows for every query, a workspace with a
 * look-alike id) can never place a finding at the wrong subscription. Anything short of a clear
 * answer, including a lookup that throws, is `null` and a warning in the log; the caller decides
 * what that means for its finding. This never throws.
 *
 * Used by `runLawRules()` for a fresh finding and by the web app's startup step for a stored one, so
 * both place a Logs finding the same way.
 */
export async function resolveWorkspacePlacement(ctx: TenantContext): Promise<WorkspacePlacement | null> {
  const customerId = ctx.logAnalyticsWorkspaceId?.trim();
  if (!customerId) return null;
  try {
    const rows = await ctx.queryARG<Record<string, unknown>>(
      `resources\n| where type =~ 'microsoft.operationalinsights/workspaces'\n`
      + `| where tostring(properties.customerId) =~ '${customerId.replace(/'/g, "''")}'\n`
      + `| project id, subscriptionId, resourceGroup, customerId = tostring(properties.customerId)`,
    );
    const match = rows.find(r => String(r['customerId'] ?? '').toLowerCase() === customerId.toLowerCase());
    const subscriptionId = match ? String(match['subscriptionId'] ?? '') : '';
    if (!match || subscriptionId === '') {
      ctx.log('The configured Log Analytics workspace was not found in Resource Graph, so its findings have no subscription.', {
        operation: 'workspace-placement', level: 'warn',
      });
      return null;
    }
    const resourceGroup = match['resourceGroup'] ? String(match['resourceGroup']) : undefined;
    return { subscriptionId, resourceGroup };
  } catch (err) {
    ctx.log(`Looking up the Log Analytics workspace failed, so its findings have no subscription: ${extractAzureErrorMessage(err)}`, {
      operation: 'workspace-placement', level: 'warn',
    });
    return null;
  }
}
