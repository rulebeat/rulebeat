import { ResourceGraphClient as SdkResourceGraphClient } from '@azure/arm-resourcegraph';
import type { TokenCredential } from '@azure/identity';
import type { QueryScope } from '../types.js';
import { AZURE_CALL_TIMEOUT_MS } from '../net/fetch-retry.js';

interface MinimalCtx {
  credential: TokenCredential;
  subscriptionIds: string[];
}

const PAGE_SIZE = 1000;
// Azure Resource Graph's documented per-request subscription limit — an explicit or tenant-default
// list longer than this must be split into multiple requests, not sent as one oversized call.
const SUBSCRIPTION_BATCH_SIZE = 1000;

/** Thrown when Azure reports a query's results as truncated (its internal result-size limit was hit,
 *  independent of skipToken paging). The rows already seen are real but the set is known-incomplete,
 *  so callers must not treat it as an authoritative "nothing else matched" result. */
export class ResourceGraphTruncatedError extends Error {
  constructor(public readonly rowsSeen: number) {
    super(
      `Resource Graph reported this query's results as truncated after ${rowsSeen} row(s) — ` +
      'Azure could not enumerate the full match set for this query.',
    );
    this.name = 'ResourceGraphTruncatedError';
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface BatchScope {
  subscriptions?: string[];
  managementGroups?: string[];
}

export class ResourceGraphClient {
  private readonly client: SdkResourceGraphClient;
  private readonly subscriptionIds: string[];

  constructor(ctx: MinimalCtx) {
    this.client = new SdkResourceGraphClient(ctx.credential);
    this.subscriptionIds = ctx.subscriptionIds;
  }

  /** One physical ARG request, paginated via skipToken until exhausted. Throws
   *  ResourceGraphTruncatedError after full pagination if any page reported resultTruncated. */
  private async *queryBatch<TRow>(kql: string, batch: BatchScope): AsyncGenerator<TRow> {
    let skipToken: string | undefined;
    let truncated = false;
    let rowsSeen = 0;
    do {
      const response = (await this.client.resources({
        query: kql,
        ...(batch.subscriptions ? { subscriptions: batch.subscriptions } : {}),
        ...(batch.managementGroups ? { managementGroups: batch.managementGroups } : {}),
        options: { resultFormat: 'objectArray', top: PAGE_SIZE, skipToken },
      }, { timeout: AZURE_CALL_TIMEOUT_MS })) as { data?: unknown[]; skipToken?: string; resultTruncated?: 'true' | 'false' };

      const rows = (response.data ?? []) as TRow[];
      rowsSeen += rows.length;
      if (response.resultTruncated === 'true') truncated = true;
      for (const row of rows) yield row;
      skipToken = response.skipToken;
    } while (skipToken);

    if (truncated) throw new ResourceGraphTruncatedError(rowsSeen);
  }

  /** Splits a subscriptions-only request into SUBSCRIPTION_BATCH_SIZE-sized batches. A
   *  managementGroups-only request has no subscription list to batch, so it's a single call. */
  private async *queryBatchesFor<TRow>(kql: string, scope: BatchScope): AsyncGenerator<TRow> {
    if (!scope.subscriptions || scope.subscriptions.length <= SUBSCRIPTION_BATCH_SIZE) {
      yield* this.queryBatch<TRow>(kql, scope);
      return;
    }
    for (const batch of chunk(scope.subscriptions, SUBSCRIPTION_BATCH_SIZE)) {
      yield* this.queryBatch<TRow>(kql, { subscriptions: batch });
    }
  }

  async *query<TRow = Record<string, unknown>>(kql: string, scope?: QueryScope): AsyncGenerator<TRow> {
    const explicitSubs = scope?.subscriptions?.length ? scope.subscriptions : undefined;
    const managementGroups = scope?.managementGroups?.length ? scope.managementGroups : undefined;
    // Azure Resource Graph rejects a request that sets both `subscriptions` and `managementGroups`.
    // A rule scoped to management groups only must never fall back to the tenant subscription list —
    // that would silently widen (and change the meaning of) a management-group-scoped query.
    const subscriptions = explicitSubs ?? (managementGroups ? undefined : this.subscriptionIds);

    if (subscriptions && managementGroups) {
      // Both explicitly set on the rule: Azure can't take one request for both, so run two
      // sequential requests and merge, deduping by resource id (a resource reachable through both
      // the explicit subscription list and the management-group tree would otherwise double-count).
      const seen = new Set<string>();
      for await (const row of this.queryBatchesFor<TRow>(kql, { subscriptions })) {
        const id = String((row as Record<string, unknown>)['id'] ?? '');
        if (id) { if (seen.has(id)) continue; seen.add(id); }
        yield row;
      }
      for await (const row of this.queryBatchesFor<TRow>(kql, { managementGroups })) {
        const id = String((row as Record<string, unknown>)['id'] ?? '');
        if (id) { if (seen.has(id)) continue; seen.add(id); }
        yield row;
      }
      return;
    }

    yield* this.queryBatchesFor<TRow>(kql, { subscriptions, managementGroups });
  }

  async queryAll<TRow = Record<string, unknown>>(kql: string, scope?: QueryScope): Promise<TRow[]> {
    const rows: TRow[] = [];
    for await (const row of this.query<TRow>(kql, scope)) rows.push(row);
    return rows;
  }
}
