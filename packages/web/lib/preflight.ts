import { fetchWithRetry, LogAnalyticsNotConfiguredError, type TenantContext } from '@rulebeat/core';
import { describeCredentialFailure, NO_SUBSCRIPTIONS_MESSAGE } from './azure-credential';
import { safeErrorMessage } from './api-error';

/**
 * "What can this credential see" — the shared diagnostic core behind onboarding step 2 and (later)
 * the B4 diagnostics page. Takes an injected `TenantContext` rather than resolving one itself, so it
 * stays green under `tests/unit/azure-credential-chokepoint.test.ts` and testable with
 * `fakeTenantContext()`, whose credential deliberately throws if anything tries to use it for real.
 *
 * Every branch below returns a hand-written, client-safe sentence. The real error always goes to
 * `console.error` first — mirroring `serverError()` in `lib/api-error.ts` — because an ARG or Graph
 * error carries the tenant id, subscription ids and correlation ids, none of which belong in a
 * response an admin might screenshot into a support thread.
 */

export type PreflightStatus = 'ok' | 'warn' | 'fail' | 'skipped';
export type PreflightCheckId = 'credential' | 'subscriptions' | 'resource-graph' | 'graph-applications' | 'log-analytics';

export interface PreflightCheck {
  id: PreflightCheckId;
  label: string;
  status: PreflightStatus;
  /** One plain sentence. ALWAYS client-safe. */
  summary: string;
  /** What to do about it. ALWAYS client-safe. */
  remediation?: string;
  /** Counts/names only, never error text. */
  detail?: Record<string, unknown>;
  durationMs: number;
}

export interface PreflightResult {
  ranAt: string;
  overall: PreflightStatus;
  checks: PreflightCheck[];
  subscriptions: Array<{ id: string; name: string }>;
}

export interface PreflightOptions {
  ctx: TenantContext;
  /** Test seam. Defaults to `ctx.credential.getToken(scope)`. */
  getToken?: (scope: string) => Promise<string | null>;
  /** Test seam. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Named in the Graph remediation text, so an admin knows which app registration to grant consent to. */
  clientId?: string;
  /** Default true. Set false to skip the Graph probe entirely — `fetchImpl` is then never called. */
  includeGraph?: boolean;
}

function graphRemediation(clientId?: string): string {
  const target = clientId ? `the app registration (client ID ${clientId})` : 'the app registration RuleBeat scans with';
  return `Grant ${target} the Microsoft Graph "Application.Read.All" permission (read-only) and an admin consent, then re-run this check.`;
}

async function checkCredential(getToken: (scope: string) => Promise<string | null>): Promise<PreflightCheck> {
  const start = Date.now();
  try {
    const token = await getToken('https://management.azure.com/.default');
    const durationMs = Date.now() - start;
    if (!token) {
      return {
        id: 'credential', label: 'Azure credential', status: 'fail',
        summary: 'Azure returned no token for the configured credential.',
        remediation: 'Check the service principal in Settings → Azure connection, or the environment variables supplying it.',
        durationMs,
      };
    }
    return { id: 'credential', label: 'Azure credential', status: 'ok', summary: 'RuleBeat can authenticate to Azure.', durationMs };
  } catch (err) {
    console.error('[RuleBeat] preflight credential check failed:', err);
    return {
      id: 'credential', label: 'Azure credential', status: 'fail',
      summary: describeCredentialFailure(err),
      remediation: 'Check the service principal in Settings → Azure connection, or the environment variables supplying it.',
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Reads `ctx.subscriptionIds` rather than calling `listAccessibleSubscriptions()` again.
 *
 * The route builds `ctx` via `createTenantContext()` moments before calling `runPreflight()`, and
 * that construction already resolved this exact list — a second live call would be redundant in
 * production and, worse, untestable: `fakeTenantContext()`'s credential deliberately throws if
 * anything tries to use it for a real Azure SDK call, and this codebase's rule is no live Azure
 * calls in tests. Reading the already-resolved list keeps this check fast and fully exercisable
 * through the fake context.
 */
function checkSubscriptions(ctx: TenantContext): { check: PreflightCheck; subscriptionIds: string[] } {
  const start = Date.now();
  const ids = ctx.subscriptionIds;
  const durationMs = Date.now() - start;

  if (ids.length === 0) {
    return {
      subscriptionIds: [],
      check: {
        id: 'subscriptions', label: 'Subscription access', status: 'fail',
        summary: NO_SUBSCRIPTIONS_MESSAGE,
        remediation: 'Assign the Reader role on at least one subscription or management group.',
        durationMs,
      },
    };
  }
  return {
    subscriptionIds: ids,
    check: {
      id: 'subscriptions', label: 'Subscription access', status: 'ok',
      summary: `This identity can see ${ids.length} subscription${ids.length === 1 ? '' : 's'}.`,
      detail: { count: ids.length },
      durationMs,
    },
  };
}

async function checkResourceGraph(
  ctx: TenantContext,
  expectedCount: number,
): Promise<{ check: PreflightCheck; subscriptions: Array<{ id: string; name: string }> }> {
  const start = Date.now();
  try {
    const rows = await ctx.queryARG<{ subscriptionId?: string; name?: string }>(
      `ResourceContainers | where type == 'microsoft.resources/subscriptions' | project subscriptionId, name`,
    );
    const durationMs = Date.now() - start;
    const subscriptions = rows
      .filter((r): r is { subscriptionId: string; name: string } => !!r.subscriptionId)
      .map(r => ({ id: r.subscriptionId, name: r.name ?? r.subscriptionId }));

    if (subscriptions.length === 0) {
      return {
        subscriptions: [],
        check: {
          id: 'resource-graph', label: 'Resource Graph', status: 'fail',
          summary: 'Azure Resource Graph returned no subscriptions for this identity.',
          durationMs,
        },
      };
    }

    // A count mismatch against the subscriptions check means Reader is assigned somewhere Resource
    // Graph doesn't yet index — invisible today, so surface it rather than silently under-reporting.
    const status: PreflightStatus = expectedCount > 0 && subscriptions.length !== expectedCount ? 'warn' : 'ok';
    return {
      subscriptions,
      check: {
        id: 'resource-graph', label: 'Resource Graph', status,
        summary: status === 'warn'
          ? `Resource Graph returned ${subscriptions.length} of the ${expectedCount} subscriptions this identity has access to.`
          : `Resource Graph is reachable and returned ${subscriptions.length} subscription${subscriptions.length === 1 ? '' : 's'}.`,
        detail: { count: subscriptions.length },
        durationMs,
      },
    };
  } catch (err) {
    return {
      subscriptions: [],
      check: {
        id: 'resource-graph', label: 'Resource Graph', status: 'fail',
        summary: safeErrorMessage('Preflight resource-graph check', err),
        durationMs: Date.now() - start,
      },
    };
  }
}

async function checkGraphApplications(
  getToken: (scope: string) => Promise<string | null>,
  fetchImpl: typeof fetch,
  clientId?: string,
): Promise<PreflightCheck> {
  const start = Date.now();
  const remediation = graphRemediation(clientId);
  try {
    const token = await getToken('https://graph.microsoft.com/.default');
    if (!token) {
      return {
        id: 'graph-applications', label: 'Microsoft Graph (directory rules)', status: 'warn',
        summary: 'Could not get a Microsoft Graph token for this identity, so directory rules will be skipped.',
        remediation, durationMs: Date.now() - start,
      };
    }

    const res = await fetchWithRetry('https://graph.microsoft.com/v1.0/applications?$select=id&$top=1', {
      headers: { Authorization: `Bearer ${token}` },
    }, { fetchImpl });
    const durationMs = Date.now() - start;

    // Directory rules are 1 backend among several, and the product works without this one — a red
    // FAILED here reads as "RuleBeat is broken" when really it just means directory rules are
    // unavailable, so this is warn, not fail.
    if (res.status === 403) {
      return {
        id: 'graph-applications', label: 'Microsoft Graph (directory rules)', status: 'warn',
        summary: 'This identity does not have permission to read Microsoft Graph applications, so directory rules will be skipped.',
        remediation, durationMs,
      };
    }
    if (!res.ok) {
      console.error(`[RuleBeat] preflight graph-applications check: Microsoft Graph responded with HTTP ${res.status}`);
      return {
        id: 'graph-applications', label: 'Microsoft Graph (directory rules)', status: 'warn',
        summary: 'Microsoft Graph did not respond as expected, so directory rules will be skipped.',
        remediation, durationMs,
      };
    }
    return {
      id: 'graph-applications', label: 'Microsoft Graph (directory rules)', status: 'ok',
      summary: 'Microsoft Graph is reachable — directory rules will run.',
      durationMs,
    };
  } catch (err) {
    console.error('[RuleBeat] preflight graph-applications check failed:', err);
    return {
      id: 'graph-applications', label: 'Microsoft Graph (directory rules)', status: 'warn',
      summary: 'Could not reach Microsoft Graph, so directory rules will be skipped.',
      remediation, durationMs: Date.now() - start,
    };
  }
}

/**
 * Log Analytics is one query backend among several (spec 035) — a rule-authoring feature the
 * product works without, same framing as `checkGraphApplications` above — so an unreachable or
 * misconfigured workspace only ever warns, never fails the overall result. "Not configured" is its
 * own `skipped` status rather than a warn, since a fresh install with no workspace connected yet is
 * the expected default state, not a problem to flag.
 */
async function _checkLogAnalytics(ctx: TenantContext): Promise<PreflightCheck> {
  const start = Date.now();
  try {
    await ctx.queryLogs('print 1');
    return {
      id: 'log-analytics', label: 'Log Analytics', status: 'ok',
      summary: 'Log Analytics is reachable.',
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    if (err instanceof LogAnalyticsNotConfiguredError) {
      return {
        id: 'log-analytics', label: 'Log Analytics', status: 'skipped',
        summary: 'No Log Analytics workspace is configured, so log-based rules are unavailable.',
        remediation: 'Connect a workspace in Settings → Log Analytics to enable log-based rules.',
        durationMs,
      };
    }
    console.error('[RuleBeat] preflight log-analytics check failed:', err);
    return {
      id: 'log-analytics', label: 'Log Analytics', status: 'warn',
      summary: safeErrorMessage('Preflight log-analytics check', err),
      remediation: 'Check the workspace ID in Settings → Log Analytics and that this identity has the Log Analytics Reader role.',
      durationMs,
    };
  }
}

export async function runPreflight(opts: PreflightOptions): Promise<PreflightResult> {
  const { ctx } = opts;
  const getToken = opts.getToken ?? (async (scope: string) => {
    const token = await ctx.credential.getToken(scope);
    return token?.token ?? null;
  });
  const fetchImpl = opts.fetchImpl ?? fetch;
  const includeGraph = opts.includeGraph ?? true;

  const credentialCheck = await checkCredential(getToken);
  const { check: subscriptionsCheck, subscriptionIds } = checkSubscriptions(ctx);
  const { check: resourceGraphCheck, subscriptions } = await checkResourceGraph(ctx, subscriptionIds.length);

  const graphCheck: PreflightCheck = includeGraph
    ? await checkGraphApplications(getToken, fetchImpl, opts.clientId)
    : {
        id: 'graph-applications', label: 'Microsoft Graph (directory rules)', status: 'skipped',
        summary: 'Directory rules were not run.', durationMs: 0,
      };
  // _checkLogAnalytics() stays defined but unused (spec 038) — Log Analytics rule/query authoring
  // is paused in the GUI pending multi-workspace targeting, so its preflight row is paused too.
  const checks = [credentialCheck, subscriptionsCheck, resourceGraphCheck, graphCheck];
  const overall: PreflightStatus = checks.some(c => c.status === 'fail')
    ? 'fail'
    : checks.some(c => c.status === 'warn') ? 'warn' : 'ok';

  return { ranAt: new Date().toISOString(), overall, checks, subscriptions };
}
