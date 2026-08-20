import { LogsQueryClient } from '@azure/monitor-query-logs';
import type { LogsTable } from '@azure/monitor-query-logs';
import type { TokenCredential } from '@azure/identity';
import { AZURE_CALL_TIMEOUT_MS } from '../net/fetch-retry.js';
import { extractAzureErrorMessage } from '../errors.js';

/** Thrown when a Log Analytics query comes back as PartialFailure — Azure could not evaluate the
 *  full query (a sub-expression timed out, hit a service limit, etc.). The rows already reported are
 *  real but the set is known-incomplete, so callers must not treat it as an authoritative result —
 *  mirrors ResourceGraphTruncatedError/GraphTruncatedError's shape and all-or-nothing contract: no
 *  partial rows are returned, only a count. */
export class LogAnalyticsTruncatedError extends Error {
  constructor(public readonly rowsSeen: number) {
    super(
      `Log Analytics reported this query as a partial failure after ${rowsSeen} row(s) — ` +
      'Azure could not evaluate the full query.',
    );
    this.name = 'LogAnalyticsTruncatedError';
  }
}

/** Thrown by TenantContext.queryLogs when no Log Analytics workspace is configured. Distinct from a
 *  network/auth failure: this is an immediate, expected rejection with no call to Azure attempted. */
export class LogAnalyticsNotConfiguredError extends Error {
  constructor() {
    super(
      'No Log Analytics workspace is configured. Set one in Settings or ' +
      'RULEBEAT_LOG_ANALYTICS_WORKSPACE_ID.',
    );
    this.name = 'LogAnalyticsNotConfiguredError';
  }
}

/** Converts a LogsTable's column-oriented shape (columnDescriptors + positional rows) into
 *  row-oriented records keyed by column name. Pure and SDK-independent — this is what's unit tested,
 *  not the network call around it. */
export function rowsFromLogsTable<TRow = Record<string, unknown>>(table: LogsTable): TRow[] {
  const columns = table.columnDescriptors.map((c) => c.name);
  return table.rows.map((row) => {
    const record: Record<string, unknown> = {};
    columns.forEach((name, i) => { record[name] = row[i]; });
    return record as TRow;
  });
}

/**
 * Executes one KQL query against a single Log Analytics workspace. A single-purpose function rather
 * than a class — unlike ResourceGraphClient there's no pagination state to hold between calls — since
 * LAW's single-query/tabular-result/partial-status model is much closer to ARG than to Graph's
 * paginated REST collections (spec 035 self-challenge: a new backend gets its own engine, not a
 * branch inside an existing one, but doesn't have to copy an unrelated backend's shape either).
 *
 * The outer timespan is deliberately unbounded ({ startTime: epoch, endTime: now }) — Azure
 * intersects it with any TimeGenerated filter already inside the KQL text, so the rule's own
 * `| where` clause remains the real scoping mechanism, same as an ARG rule scopes itself.
 */
export async function queryLogAnalyticsWorkspace<TRow = Record<string, unknown>>(
  credential: TokenCredential,
  workspaceId: string,
  kql: string,
): Promise<TRow[]> {
  const client = new LogsQueryClient(credential);

  const result = await client.queryWorkspace(
    workspaceId,
    kql,
    { startTime: new Date(0), endTime: new Date() },
    { abortSignal: AbortSignal.timeout(AZURE_CALL_TIMEOUT_MS) },
  ).catch((err: unknown) => {
    throw new Error(extractAzureErrorMessage(err));
  });

  if (result.status === 'Success') {
    const table = result.tables[0];
    return table ? rowsFromLogsTable<TRow>(table) : [];
  }

  const rowsSeen = result.partialTables.reduce((sum, t) => sum + t.rows.length, 0);
  throw new LogAnalyticsTruncatedError(rowsSeen);
}
