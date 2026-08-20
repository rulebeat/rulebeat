import {
  DefaultAzureCredential,
  type DefaultAzureCredentialOptions,
  type TokenCredential,
} from '@azure/identity';
import { SubscriptionClient } from '@azure/arm-resources-subscriptions';
import type { TenantContext } from '../types.js';
import { ResourceGraphClient } from '../clients/resource-graph.js';
import { queryLogAnalyticsWorkspace, LogAnalyticsNotConfiguredError } from '../clients/log-analytics.js';
import { AZURE_CALL_TIMEOUT_MS, AZURE_LIST_TIMEOUT_MS, fetchWithRetry } from '../net/fetch-retry.js';

export interface BuildTenantContextOptions {
  tenantId?: string;
  subscriptionIds?: string[];
  credential?: TokenCredential;
  /** Matches TenantContext.log's shape (message, optional structured fields). A caller that only
   *  ever passes a bare message — as this option's declared type still allows — keeps working: JS
   *  ignores an argument a function doesn't declare, and TypeScript's structural typing accepts a
   *  fewer-parameter function wherever the wider signature is expected. */
  log?: (msg: string) => void;
  /** The single default Log Analytics workspace (spec 035) — undefined means "not configured," which
   *  produces a `queryLogs` that rejects immediately rather than attempting a call. Resolved by the
   *  caller (web app's `createTenantContext()`) before this function is invoked; this function has no
   *  opinion on env-vs-stored precedence, same division of responsibility as `credential` above. */
  logAnalyticsWorkspaceId?: string;
}

export async function buildTenantContext(
  options: BuildTenantContextOptions = {},
): Promise<TenantContext> {
  const tenantId = options.tenantId ?? process.env['AZURE_TENANT_ID'];
  if (!tenantId) {
    throw new Error('Tenant ID is required. Pass tenantId or set AZURE_TENANT_ID.');
  }

  const credentialOptions: DefaultAzureCredentialOptions = { tenantId };
  const credential = options.credential ?? new DefaultAzureCredential(credentialOptions);
  const log = options.log ?? (() => {});

  const subscriptionIds =
    options.subscriptionIds && options.subscriptionIds.length > 0
      ? options.subscriptionIds
      : await listAccessibleSubscriptions(credential);

  if (subscriptionIds.length === 0) {
    throw new Error(
      'No accessible subscriptions found. Verify the credential has Reader on at least one subscription.',
    );
  }

  const baseCtx = { tenantId, subscriptionIds, credential, log };
  const argClient = new ResourceGraphClient(baseCtx);
  const workspaceId = options.logAnalyticsWorkspaceId;

  return {
    ...baseCtx,
    queryARG: <TRow = Record<string, unknown>>(kql: string, scope?: import('../types.js').QueryScope) =>
      argClient.queryAll<TRow>(kql, scope),
    graphGet: <TValue = Record<string, unknown>>(path: string) => graphGetAll<TValue>(credential, path),
    queryLogs: <TRow = Record<string, unknown>>(kql: string) =>
      workspaceId
        ? queryLogAnalyticsWorkspace<TRow>(credential, workspaceId, kql)
        : Promise.reject(new LogAnalyticsNotConfiguredError()),
  };
}

/**
 * Row cap for `graphGetAll()` (spec 032). Unlike Resource Graph, which self-reports truncation via
 * `resultTruncated` after a page comes back, Graph's `@odata.nextLink` paging has no equivalent
 * signal — left unbounded, a rule against a tenant with an unusually large object set would page
 * forever. Set high enough that a normal tenant's directory never trips it; a tenant that does is
 * exactly the case `GraphTruncatedError` exists to surface instead of silently paging for minutes.
 */
export const GRAPH_MAX_ROWS = 10_000;

/**
 * Thrown by `graphGetAll()` when the accumulated result crosses `GRAPH_MAX_ROWS` before
 * `@odata.nextLink` is exhausted. Mirrors `ResourceGraphTruncatedError`'s shape (rowsSeen + a status
 * a rule's outcome can map to `capped`), but the cause differs: ARG's truncation is Azure asserting
 * "I stopped enumerating," this is RuleBeat choosing to stop rather than asking a caller to wait on
 * an unbounded fetch.
 */
export class GraphTruncatedError extends Error {
  constructor(public readonly rowsSeen: number) {
    super(
      `Microsoft Graph result set exceeded ${rowsSeen} row(s) — RuleBeat stopped paginating before ` +
      'reaching the end of the result set.',
    );
    this.name = 'GraphTruncatedError';
  }
}

/**
 * Default `TenantContext.graphGet` for a real Azure connection: a bearer token from the same
 * credential every other call uses, GET against Graph, and follow `@odata.nextLink` until
 * exhausted or `GRAPH_MAX_ROWS` is crossed. Lives here rather than in the web app so every real
 * `TenantContext` — not just the one `createTenantContext()` builds — gets it for free.
 */
async function graphGetAll<TValue>(credential: TokenCredential, path: string): Promise<TValue[]> {
  const token = await credential.getToken('https://graph.microsoft.com/.default', {
    abortSignal: AbortSignal.timeout(AZURE_CALL_TIMEOUT_MS),
  });
  if (!token) throw new Error('Could not acquire a Microsoft Graph token for the configured credential.');

  const values: TValue[] = [];
  let url: string | null = path.startsWith('http') ? path : `https://graph.microsoft.com/v1.0${path}`;

  while (url) {
    const res: Response = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${token.token}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Graph API ${res.status}: ${body.slice(0, 200)}`);
    }
    const page = await res.json() as { value: TValue[]; '@odata.nextLink'?: string };
    values.push(...page.value);
    url = page['@odata.nextLink'] ?? null;

    // Only a genuine early-stop counts as truncation — a result that happens to cross the cap on
    // its actual last page is complete, not capped, so this never fires once url is already null.
    if (url && values.length > GRAPH_MAX_ROWS) {
      throw new GraphTruncatedError(values.length);
    }
  }

  return values;
}

export async function listAccessibleSubscriptions(
  credential: TokenCredential,
): Promise<string[]> {
  const client = new SubscriptionClient(credential);
  const ids: string[] = [];
  for await (const sub of client.subscriptions.list({
    abortSignal: AbortSignal.timeout(AZURE_LIST_TIMEOUT_MS),
  })) {
    if (sub.subscriptionId && sub.state === 'Enabled') {
      ids.push(sub.subscriptionId);
    }
  }
  return ids;
}
