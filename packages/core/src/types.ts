import type { TokenCredential } from '@azure/identity';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
// Categories are now DB-defined and user-extensible, not a closed enum.
// The named slugs below are kept as documentation/seed constants only.
export type ModuleCategory = string;
export const BUILTIN_CATEGORIES = ['security', 'cost', 'compliance', 'identity', 'networking', 'operations', 'reliability'] as const;
export type BuiltinCategory = typeof BUILTIN_CATEGORIES[number];
export type RemediationStepType = 'az-cli' | 'powershell' | 'portal' | 'terraform' | 'bicep';

export interface RemediationStep {
  type: RemediationStepType;
  title: string;
  content: string;
}

export interface Finding {
  // Identity
  module: string;
  ruleId: string;
  fingerprint: string;

  // Classification
  severity: Severity;
  category: ModuleCategory;

  /**
   * 'state' (default) is a resource currently in a wrong configuration — has resourceId/Type/Name
   * below. 'activity' (spec 034) is an occurrence with no resource to point at — resourceId/Type/Name
   * are absent and `dimensionKey` carries whatever makes this occurrence distinct instead. Optional
   * rather than required so every existing ARG/Graph call site (which only ever produces 'state'
   * findings) needs no change; absence means 'state', same default the `findings` table column uses.
   */
  kind?: 'state' | 'activity';
  /** Human-readable identity of an 'activity' occurrence's pattern (e.g. "principal foo@bar.com") —
   *  what `computeActivityFingerprint()` hashed. Absent for 'state' findings. */
  dimensionKey?: string;

  // Resource — absent for kind: 'activity' findings, which have no resource to describe.
  resourceId?: string;
  resourceType?: string;
  resourceName?: string;
  subscriptionId: string;
  resourceGroup?: string;
  location?: string;

  // Content
  title: string;
  description: string;
  evidence: Record<string, unknown>;

  // Actionability
  recommendation: string;
  remediationSteps: RemediationStep[];
  estimatedMonthlyCost?: number;
  azurePortalLink?: string;

  detectedAt: Date;
}

export interface QueryScope {
  subscriptions?: string[];
  managementGroups?: string[];
}

/**
 * Structured context attached to a `TenantContext.log()` call. `level` is set explicitly by the
 * caller rather than inferred from `status` — an enrichment failure, for example, is worth `'warn'`
 * even when the rule's own outcome afterward is still `success`/`capped`, and inferring one from the
 * other would mislabel one of them. Every field is optional: a caller with nothing structured to add
 * can still call `log(message)` with no second argument at all.
 */
export interface LogFields {
  operation?: string;
  ruleId?: string;
  category?: string;
  status?: string;
  findingCount?: number;
  durationMs?: number;
  level?: 'info' | 'warn' | 'error';
}

export interface TenantContext {
  tenantId: string;
  subscriptionIds: string[];
  credential: TokenCredential;
  queryARG<TRow = Record<string, unknown>>(kql: string, scope?: QueryScope): Promise<TRow[]>;
  log(message: string, fields?: LogFields): void;
  /**
   * Microsoft Graph's counterpart to `queryARG` — required like it (spec 032 Decision 3), since a
   * broken Graph connection must surface as a real, visible error rather than a rule silently
   * behaving as if it found nothing. Its real purpose is testability: without this seam, Graph-backed
   * rules could only ever be exercised against live Graph, which CLAUDE.md's testing rules already
   * ban ("no live Azure or Graph calls in tests"). Real contexts implement it with
   * `credential.getToken()` plus `fetch`; a fake context (tests, demo mode) can answer it from static
   * data with no network at all. `path` is the Graph request path including query string, e.g.
   * `/applications?$select=...`; the full paginated `value` array is returned (bounded by a page/row
   * cap — see `graphGetAll` in `auth/index.ts`), `@odata.nextLink` following handled internally by
   * whoever implements this.
   */
  graphGet<TValue = Record<string, unknown>>(path: string): Promise<TValue[]>;
  /**
   * Log Analytics' counterpart to `queryARG`/`graphGet` (spec 035) — required like them, since a
   * misconfigured or unreachable workspace must surface as a real, visible error rather than a rule
   * silently behaving as if it found nothing. Runs `kql` against the single default workspace closed
   * over at `TenantContext` construction (per-rule workspace selection is deferred, spec 036); a
   * context built with no workspace configured returns a `queryLogs` that immediately rejects with
   * `LogAnalyticsNotConfiguredError` rather than attempting a call. A query Azure reports as partially
   * evaluated rejects with `LogAnalyticsTruncatedError` — never resolves with a partial row set, same
   * all-or-nothing contract as `queryARG`'s `ResourceGraphTruncatedError`. Both error classes and the
   * real implementation live in `clients/log-analytics.ts`; a fake context (tests, demo mode) can
   * answer it from static data with no network at all.
   */
  queryLogs<TRow = Record<string, unknown>>(kql: string): Promise<TRow[]>;
}

export interface ScanSummary {
  module: string;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  subscriptionsScanned: string[];
  findings: Finding[];
  counts: Record<Severity, number>;
}
