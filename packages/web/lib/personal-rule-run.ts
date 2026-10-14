/**
 * Running a Personal rule (#280, ADR 0011). A Personal rule is a query its author wrote, so it is
 * limited by its request and never by filtering its rows or rewriting its KQL: Resource Graph is sent
 * only the overlap of the rule's own scope and the subscriptions and management groups the author
 * holds now, and a Microsoft Graph rule runs only when the author holds the Directory.
 *
 * `limitedContext()` is the one place that limit is put on a context. The run and the save-time
 * probes both go through it, since the probes also reach Azure.
 */
import { runGraphRules, runRules, type QueryScope, type Rule, type RuleRunEvent, type RuleScope, type Finding as CoreFinding, type TenantContext } from '@rulebeat/core';
import { DIRECTORY_SCOPE_PATH, EVERYTHING_TENANT_ID, type Access } from '@/lib/access-model';
import { can } from '@/lib/rbac';
import {
  mayQueryDirectory, mayWriteQueries, queryScopeLimit, resourceGraphScope,
} from '@/lib/written-query';
import { EVERYTHING_COVERED, type CoveredEntry } from '@/lib/run-scope';
import { mergeFindingsByFingerprint, type FindingRow } from '@/lib/finding-rows';
import { SEVERITY_ORDER } from '@/lib/severity';
import type { PersonalRule, PersonalRuleResult, PersonalRunStatus } from '@/lib/db/personal-rules';

const ACTION = 'rules:validate';
const MANAGEMENT_GROUP_PATH = '/providers/Microsoft.Management/managementGroups/';

export const LOGS_PAUSED_MESSAGE = 'Log Analytics rules cannot be written yet: Logs authoring is paused.';

/**
 * The context a Personal rule asks Azure through. Every Resource Graph request, the rule's query and
 * the enrichment follow-up alike, goes out with only the overlap of its scope and what `access`
 * holds; a request that shares nothing with it is refused, never sent empty (Resource Graph's client
 * reads an empty scope as every subscription). Microsoft Graph is open only to a holder of the
 * Directory, and Logs is never open.
 */
export function limitedContext(ctx: TenantContext, access: Access): TenantContext {
  return {
    ...ctx,
    queryARG: async <TRow = Record<string, unknown>>(kql: string, scope?: QueryScope) => {
      const decided = resourceGraphScope(access, scope);
      if (!decided.ok) throw new Error(decided.error);
      return ctx.queryARG<TRow>(kql, decided.scope);
    },
    graphGet: async <TValue = Record<string, unknown>>(path: string) => {
      const decided = mayQueryDirectory(access);
      if (!decided.ok) throw new Error(decided.error);
      return ctx.graphGet<TValue>(path);
    },
    queryLogs: async () => { throw new Error(LOGS_PAUSED_MESSAGE); },
  };
}

export type PersonalRunPlan =
  | { ok: true; scope: QueryScope | undefined; covered: CoveredEntry[] }
  | { ok: false; error: string };

const named = (value: string[] | undefined): string[] | undefined => (value && value.length > 0 ? value : undefined);

function lastSegment(path: string): string {
  return path.split('/').pop() ?? '';
}

/**
 * Whether `access` may run this rule now, what Resource Graph is sent, and the Scopes the run
 * covers. Pure: the route refuses on `ok: false` before any request leaves.
 */
export function planPersonalRun(rule: Pick<Rule, 'queryBackend' | 'scope'>, access: Access): PersonalRunPlan {
  const mayWrite = mayWriteQueries(access);
  if (!mayWrite.ok) return mayWrite;

  const everything = queryScopeLimit(access) === null;

  if (rule.queryBackend === 'log-analytics') return { ok: false, error: LOGS_PAUSED_MESSAGE };

  if (rule.queryBackend === 'microsoft-graph') {
    const mayDirectory = mayQueryDirectory(access);
    if (!mayDirectory.ok) return mayDirectory;
    if (everything) return { ok: true, scope: undefined, covered: [...EVERYTHING_COVERED] };
    const grant = access.grants.find(g => g.scope.kind === 'directory' && can(g.role, ACTION));
    return { ok: true, scope: undefined, covered: [{ tenantId: grant?.tenantId ?? EVERYTHING_TENANT_ID, path: DIRECTORY_SCOPE_PATH }] };
  }

  const requested: QueryScope = {
    subscriptions: named(rule.scope?.subscriptions),
    managementGroups: named(rule.scope?.managementGroups),
  };
  const asked = requested.subscriptions || requested.managementGroups ? requested : undefined;
  const decided = resourceGraphScope(access, asked);
  if (!decided.ok) return decided;
  const scope = decided.scope as QueryScope | undefined;

  if (everything) {
    if (!scope) return { ok: true, scope, covered: [...EVERYTHING_COVERED] };
    const covered: CoveredEntry[] = [
      ...(scope.subscriptions ?? []).map(id => ({ tenantId: EVERYTHING_TENANT_ID, path: `/subscriptions/${id}` })),
      ...(scope.managementGroups ?? []).map(id => ({ tenantId: EVERYTHING_TENANT_ID, path: `${MANAGEMENT_GROUP_PATH}${id}` })),
    ];
    return { ok: true, scope, covered };
  }

  const subscriptions = new Set((scope?.subscriptions ?? []).map(s => s.toLowerCase()));
  const managementGroups = new Set((scope?.managementGroups ?? []).map(s => s.toLowerCase()));
  const seen = new Set<string>();
  const covered: CoveredEntry[] = [];
  for (const g of access.grants) {
    if (!can(g.role, ACTION)) continue;
    const id = lastSegment(g.scope.path).toLowerCase();
    const inScope = (g.scope.kind === 'subscription' && subscriptions.has(id))
      || (g.scope.kind === 'managementGroup' && managementGroups.has(id));
    const key = `${g.tenantId}|${g.scope.path.toLowerCase()}`;
    if (!inScope || seen.has(key)) continue;
    seen.add(key);
    covered.push({ tenantId: g.tenantId, path: g.scope.path });
  }
  return { ok: true, scope, covered };
}

/**
 * The scope a copy of a shared rule starts with (#281): the entries of the source's scope that
 * equal a subscription or management group the author holds, ignoring case and stored in the held
 * casing. Whoever holds Everything keeps the source's entries as they are. An empty list means "all
 * of the author's access", exactly as the Personal rule form reads it, so an empty result is never
 * expanded into a list. Matching entry by entry (not through management group expansion)
 * keeps the stored scope identical to what `planPersonalRun()` will send. `outsideAccess` is never
 * stored: it is a count for a viewer of a shared rule.
 */
export function copyScopeFor(source: RuleScope | undefined, access: Access): RuleScope {
  const level = source?.level ?? 'subscription';
  const limit = queryScopeLimit(access);
  if (limit === null) {
    return {
      level,
      ...(source?.subscriptions ? { subscriptions: [...source.subscriptions] } : {}),
      ...(source?.managementGroups ? { managementGroups: [...source.managementGroups] } : {}),
    };
  }
  const keep = (held: string[], asked: string[] | undefined): string[] => {
    const wanted = new Set((asked ?? []).map(s => s.toLowerCase()));
    return held.filter(id => wanted.has(id.toLowerCase()));
  };
  return {
    level,
    subscriptions: keep(limit.subscriptions, source?.subscriptions),
    managementGroups: keep(limit.managementGroups, source?.managementGroups),
  };
}

export interface PersonalRunResult {
  status: PersonalRunStatus;
  results: PersonalRuleResult[];
}

/**
 * Runs the rule through the engine its backend names and returns what it found. Calls core directly:
 * a Personal rule never goes through a scan, a finding sync or the findings table. Rows are never
 * filtered; what bounds the run is the context, which the caller built with `limitedContext()`.
 */
export async function runPersonalRule(rule: PersonalRule, ctx: TenantContext): Promise<PersonalRunResult> {
  const ruleToRun = { ...rule, enabled: true } as Rule;
  const findings: (CoreFinding & { fingerprint: string })[] = [];
  let status: PersonalRunStatus = 'success';

  const handle = (event: RuleRunEvent<CoreFinding>): void => {
    if (event.kind === 'finding') {
      // The engine yields one finding per row; a resource's rows are folded into one result. A
      // finding with no resource id has nothing to fold on and stays alone.
      const identity = event.finding.resourceId ? event.finding.resourceId.toLowerCase() : `#${findings.length}`;
      findings.push({ ...event.finding, fingerprint: `${event.finding.ruleId}::${identity}` });
    } else {
      status = event.outcome.status;
    }
  };

  const events = rule.queryBackend === 'microsoft-graph' ? runGraphRules([ruleToRun], ctx) : runRules([ruleToRun], ctx);
  for await (const event of events) handle(event);

  const merged = mergeFindingsByFingerprint(findings.map(f => ({ ...f, rows: undefined as FindingRow[] | undefined })));
  merged.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  return {
    status,
    results: merged.map(f => ({
      resourceId: f.resourceId,
      resourceName: f.resourceName,
      resourceType: f.resourceType,
      subscriptionId: f.subscriptionId || undefined,
      resourceGroup: f.resourceGroup,
      location: f.location,
      severity: f.severity,
      title: f.title,
      rows: f.rows,
    })),
  };
}
