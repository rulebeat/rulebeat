import type { TokenCredential } from '@azure/identity';
import { queryLogAnalyticsWorkspace } from '@rulebeat/core';
import {
  getActiveLogAnalyticsWorkspace,
  type LogAnalyticsWorkspaceSummary,
} from '@/lib/db/log-analytics-workspace';
import { describeAadstsError } from '@/lib/entra-errors';

/**
 * Resolves the default Log Analytics workspace RuleBeat queries `queryBackend: 'log-analytics'`
 * rules against (spec 035). Deliberately narrower than `resolveAzureCredential()` in
 * `lib/azure-credential.ts`: there is no ambient "chain" fallback here, because unlike an Azure
 * identity a workspace id can't be discovered — either one is named (by env or by the admin in
 * Settings) or none is configured, and `createTenantContext()` passes `undefined` through to core,
 * which is what makes `queryLogs` reject immediately for a rule that needs it.
 */

export type LogAnalyticsWorkspaceSource = 'env' | 'stored';

export const LOG_ANALYTICS_WORKSPACE_SOURCE_LABELS: Record<LogAnalyticsWorkspaceSource, string> = {
  env: 'Environment variable',
  stored: 'Configured in RuleBeat',
};

export interface ResolvedLogAnalyticsWorkspace {
  workspaceId: string;
  source: LogAnalyticsWorkspaceSource;
  /** Set only for `source: 'stored'`, so a successful verification can be recorded against the row. */
  storedWorkspaceRowId?: string;
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** Env always wins over the stored row, same reasoning as `resolveAzureCredential()` — a template
 *  deployment that names a workspace in its environment must never be overridden by a stray Settings
 *  entry. Returns null when nothing is configured; there is no third source to fall back to. */
export async function resolveLogAnalyticsWorkspaceId(): Promise<ResolvedLogAnalyticsWorkspace | null> {
  const envWorkspaceId = env('RULEBEAT_LOG_ANALYTICS_WORKSPACE_ID');
  if (envWorkspaceId) return { workspaceId: envWorkspaceId, source: 'env' };

  const stored = await getActiveLogAnalyticsWorkspace();
  if (stored) return { workspaceId: stored.workspaceId, source: 'stored', storedWorkspaceRowId: stored.id };

  return null;
}

export interface LogAnalyticsWorkspaceStatus {
  configured: boolean;
  source: LogAnalyticsWorkspaceSource | null;
  sourceLabel: string | null;
  workspaceId: string | null;
  /** True when the environment is supplying the workspace id, which means the stored one is inert —
   *  same reasoning as AzureConnectionStatus.managedByEnv. */
  managedByEnv: boolean;
  stored: LogAnalyticsWorkspaceSummary | null;
  message: string;
}

const NOT_CONFIGURED_MESSAGE = [
  'No Log Analytics workspace is configured.',
  'Rules that query Log Analytics will report "not configured" until one is set below or via',
  'RULEBEAT_LOG_ANALYTICS_WORKSPACE_ID.',
].join(' ');

/** Read-only description of the current workspace, for the settings screen and diagnostics. */
export async function getLogAnalyticsWorkspaceStatus(): Promise<LogAnalyticsWorkspaceStatus> {
  const stored = await getActiveLogAnalyticsWorkspace();
  const envWorkspaceId = env('RULEBEAT_LOG_ANALYTICS_WORKSPACE_ID');

  if (envWorkspaceId) {
    return {
      configured: true,
      source: 'env',
      sourceLabel: LOG_ANALYTICS_WORKSPACE_SOURCE_LABELS.env,
      workspaceId: envWorkspaceId,
      managedByEnv: true,
      stored,
      message: 'The Log Analytics workspace comes from this deployment’s environment variables.',
    };
  }

  if (stored) {
    return {
      configured: true,
      source: 'stored',
      sourceLabel: LOG_ANALYTICS_WORKSPACE_SOURCE_LABELS.stored,
      workspaceId: stored.workspaceId,
      managedByEnv: false,
      stored,
      message: 'Querying Log Analytics rules against the workspace configured here.',
    };
  }

  return {
    configured: false,
    source: null,
    sourceLabel: null,
    workspaceId: null,
    managedByEnv: false,
    stored: null,
    message: NOT_CONFIGURED_MESSAGE,
  };
}

export type VerifyLogAnalyticsResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Proves the existing Azure credential can actually query this workspace, by running a trivial
 * `print 1`. Run before persisting, same reasoning as `verifyAzureCredential()`: a saved workspace id
 * that has never actually answered a query is the worst state to leave an install in.
 *
 * Takes the credential as a parameter rather than resolving it internally — there is no separate
 * "Log Analytics identity" to test (spec 035 deliberately reuses the existing Azure credential), so
 * the caller passes in whatever `getAzureCredential()` already returned.
 */
export async function verifyLogAnalyticsWorkspace(
  credential: TokenCredential,
  workspaceId: string,
): Promise<VerifyLogAnalyticsResult> {
  try {
    await queryLogAnalyticsWorkspace(credential, workspaceId, 'print 1');
    return { ok: true };
  } catch (err) {
    console.error('[RuleBeat] Log Analytics workspace verification failed:', err);
    return { ok: false, error: describeLogAnalyticsFailure(err) };
  }
}

/**
 * Turns a Log Analytics query failure into something an admin can act on. Shares the AADSTS and
 * network-reachability cases with `describeCredentialFailure()` in `lib/azure-credential.ts` (the
 * credential doing the authenticating is the same one), and adds the one failure mode that's specific
 * to a workspace id rather than a credential: not found, or found but not readable by this identity.
 */
function describeLogAnalyticsFailure(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  const aadsts = describeAadstsError(raw);
  if (aadsts) return aadsts;

  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo/i.test(raw)) {
    return 'Could not reach Azure from this host. Check outbound network access and any proxy settings.';
  }
  if (/not found|NotFound|Forbidden|does not have|access.*denied/i.test(raw)) {
    return 'Azure rejected the query against this workspace. Check the workspace id, and that the '
      + 'configured Azure credential has the Log Analytics Reader role on it.';
  }
  return 'Azure rejected the query against this workspace. Check the RuleBeat server logs for the full error.';
}
