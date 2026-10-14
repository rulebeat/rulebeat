import {
  runRules,
  runGraphRules,
  runLawRules,
  resolveWorkspacePlacement,
  computeFingerprint,
  computeActivityFingerprint,
  type Finding as CoreFinding,
  type QueryScope,
  type RuleRunEvent,
  type TenantContext,
} from '@rulebeat/core';
import { createScanContext } from './scan-context';
import { loadRules, setRulesLastRunStatus } from './rules';
import { saveScanResult } from './scan-history';
import { syncScanFindingsDetailed, refreshSnapshotsFor } from './db/findings';
import { mergeFindingsByFingerprint } from './finding-rows';
import { SEVERITY_ORDER, emptySeverityCounts } from './severity';
import type { Category, ChangedFindingDetail, Finding, IncompleteRule, ScanSummary } from './types';
import type { Access } from './access-model';
import { listHierarchyNodes } from './db/management-group-hierarchy';
import type { HierarchyNode } from './management-group-tree';
import {
  coveredAccess, coveredScopeOf, coversDirectory, coversWorkspace, insideCovered, scopeForRule, subscriptionsAskedFor,
  type RequestScope,
} from './run-scope';

/**
 * The context a scoped run asks Azure through: every Resource Graph request, the rule's own query and
 * the enrichment follow-up alike, goes out with only the overlap of its scope and the Scopes the run
 * covers (#276). The KQL is never touched. A request that shares nothing with them is refused, never
 * sent empty, since Resource Graph's client reads an empty scope as every subscription. Everything else
 * on the context is the caller's own.
 */
function narrowContext(ctx: TenantContext, covered: Access, hierarchy: readonly HierarchyNode[], asked: RequestScope[]): TenantContext {
  return {
    ...ctx,
    queryARG: async <TRow = Record<string, unknown>>(kql: string, scope?: QueryScope) => {
      const narrowed = scopeForRule(scope, covered, hierarchy);
      if (!narrowed) throw new Error('This request does not overlap the access of the person who started the run, so it was not sent.');
      asked.push(narrowed);
      return ctx.queryARG<TRow>(kql, narrowed);
    },
  };
}

export interface ScanRunOutcome {
  summary: ScanSummary;
  newFindings: Finding[];
  /** Findings that gained a row since their last successful scan, each with just the added rows. */
  changedFindings: ChangedFindingDetail[];
}

export interface RunScanOptions {
  /** Who asked for the scan: the Azure context is built from it. A scheduled scan passes SYSTEM_ACCESS. */
  access: Access;
  triggeredBy?: 'manual' | 'schedule';
  scheduleId?: string;
  /** The schedule_runs execution this category's scan belongs to: links the scan row back to
   *  its run for the unified Run History drill-down. */
  runId?: string;
  ctx?: TenantContext;
  /** Restricts execution to these rule ids within the category (schedules targeting specific
   *  rules/tags). Omitted = every enabled rule in the category (the manual "Run Scan" button). */
  ruleIds?: string[];
  /** Injected by the demo generator so a replayed scan is stamped at its simulated date instead
   *  of the real current time. Every consumer of "when did this scan happen" (the scan row, the
   *  finding lifecycle timestamps, and the daily snapshot it rolls into) is driven from this one
   *  value, so a forward chronological replay produces a real trend history instead of everything
   *  landing on the day the generator happened to run. */
  now?: Date;
}

export async function runCategoryScan(category: Category, opts: RunScanOptions): Promise<ScanRunOutcome> {
  const baseCtx = opts.ctx ?? await createScanContext(opts.access);

  const startedAt = opts.now ?? new Date();
  const findings: Finding[] = [];
  const incompleteRules: IncompleteRule[] = [];

  let enabledRules = (await loadRules()).filter(r => r.enabled && r.category === category.id);
  if (opts.ruleIds) {
    const allowed = new Set(opts.ruleIds);
    enabledRules = enabledRules.filter(r => allowed.has(r.id));
  }

  // What this run covers: Everything for an Admin and the scheduler, otherwise the Scopes the runner
  // holds at a Role that runs scans (#276). Below Everything the shared rules run only where their own
  // scope and the covered Scope overlap, and a rule with no overlap is left out whole: no request, no
  // outcome, no count, and its last-run status and prior findings are untouched.
  const coveredEntries = coveredScopeOf(opts.access);
  const covered = coveredAccess(opts.access);
  const scoped = !covered.everything;
  const askedScopes: RequestScope[] = [];
  let hierarchy: HierarchyNode[] = [];
  let ctx = baseCtx;
  if (scoped) {
    // The tree is read when a rule names a management group, or the runner holds one (the subscriptions under it are listed as scanned).
    if (covered.managementGroups.length > 0 || enabledRules.some(r => r.scope.managementGroups?.length)) hierarchy = await listHierarchyNodes();
    ctx = narrowContext(baseCtx, covered, hierarchy, askedScopes);
    const lawPlacement = enabledRules.some(r => r.queryBackend === 'log-analytics')
      ? await resolveWorkspacePlacement(ctx) : null;
    enabledRules = enabledRules.filter(r => {
      if (r.queryBackend === 'microsoft-graph') return coversDirectory(covered);
      if (r.queryBackend === 'log-analytics') return coversWorkspace(covered, lawPlacement);
      return scopeForRule(r.scope, covered, hierarchy) !== null;
    });
    // The lookup above is a request of its own: it is not part of what the run scanned.
    askedScopes.length = 0;
  }
  const totalRules = enabledRules.length;
  const ruleNames = new Map(enabledRules.map(r => [r.id, r.name]));
  const advisoryRuleIds = new Set(enabledRules.filter(r => r.kind === 'advisory').map(r => r.id));

  const graphRules = enabledRules.filter(r => r.queryBackend === 'microsoft-graph');
  const lawRules = enabledRules.filter(r => r.queryBackend === 'log-analytics');
  const argRules = enabledRules.filter(r => r.queryBackend !== 'microsoft-graph' && r.queryBackend !== 'log-analytics');

  // Only rules whose outcome is 'success' may resolve a prior finding that didn't reappear:
  // 'failed' (the query threw) and 'capped' (a top-level take/top, or ARG-truncated result) are
  // both "real but not proven complete" and must leave their prior findings untouched.
  const successRuleIds: string[] = [];

  // Shared by all three backends' event loops (spec 032/036): runRules(), runGraphRules(), and
  // runLawRules() all yield the same RuleRunEvent<Finding> contract (per-rule
  // success/failed/capped/invalid outcomes, never a thrown rejection for an individual rule's
  // failure), so one handler keeps the fingerprint/timestamp transform and the
  // success/incomplete bookkeeping in exactly one place instead of duplicated per
  // backend. None of the three loops needs a try/catch of its own for the same reason: a bad rule
  // yields a 'failed' outcome event rather than throwing.
  function handleEvent(event: RuleRunEvent<CoreFinding>): void {
    if (event.kind === 'finding') {
      const finding = event.finding;
      // kind:'activity' findings have no resourceId to fingerprint on. They hash ruleId +
      // dimensionKey instead (spec 034), namespaced so it can never collide with a state
      // fingerprint for the same rule. '' is the same empty-dimensionKey convention
      // computeActivityFingerprint()'s own doc comment documents.
      const fingerprint = finding.kind === 'activity'
        ? computeActivityFingerprint(finding.ruleId, finding.dimensionKey ?? '')
        : computeFingerprint(finding.ruleId, finding.resourceId ?? '');
      // An Advisory rule's findings are stamped from the rule, not the engine: its query is the
      // same Resource Graph or Graph query a Problem rule runs, so the engine cannot know.
      findings.push({
        ...finding,
        ...(advisoryRuleIds.has(finding.ruleId) && finding.kind !== 'activity' ? { kind: 'advisory' as const } : {}),
        module: category.id,
        fingerprint,
        detectedAt: finding.detectedAt.toISOString(),
      });
      return;
    }
    if (event.outcome.status === 'success') {
      successRuleIds.push(event.outcome.ruleId);
    } else {
      incompleteRules.push({
        ruleId: event.outcome.ruleId,
        ruleName: ruleNames.get(event.outcome.ruleId) ?? event.outcome.ruleId,
        status: event.outcome.status,
      });
    }
  }

  for await (const event of runGraphRules(graphRules, ctx)) handleEvent(event);
  for await (const event of runLawRules(lawRules, ctx)) handleEvent(event);
  for await (const event of runRules(argRules, ctx)) handleEvent(event);
  const ranRuleIds = successRuleIds;

  const finishedAt = opts.now ?? new Date();
  // A rule that returns several rows for one resource (two retirements on one VM, three failing
  // node pools of one cluster) is one finding holding all of them, in query order, so it counts as
  // one sighting everywhere: the saved scan blob, Run History, notification counts, and the
  // findings lifecycle table.
  // A run below Everything keeps only the findings inside what it covered. Its request can reach more than
  // that (Resource Graph cannot be limited to a resource group), and what it did not cover is not its to
  // store, count or resolve.
  const inside = scoped ? insideCovered(covered) : null;
  const mergedFindings = mergeFindingsByFingerprint(inside ? findings.filter(inside) : findings);
  const counts = emptySeverityCounts();
  for (const f of mergedFindings) counts[f.severity]++;
  mergedFindings.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));

  const scanId = crypto.randomUUID();
  const summary: ScanSummary = {
    id: scanId,
    module: category.id,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    subscriptionsScanned: scoped ? subscriptionsAskedFor(askedScopes, hierarchy) : ctx.subscriptionIds,
    findings: mergedFindings,
    counts,
    totalRules,
    triggeredBy: opts.triggeredBy ?? 'manual',
    coverage: incompleteRules.length > 0 ? 'partial' : 'complete',
    incompleteRules,
  };

  await saveScanResult(category.id, summary, { triggeredBy: opts.triggeredBy, scheduleId: opts.scheduleId, id: scanId, runId: opts.runId, coveredScope: coveredEntries });

  const { created, reactivated, changed, affectedCategories } = await syncScanFindingsDetailed({
    scanId,
    category: category.id,
    ranRuleIds,
    findings: mergedFindings,
    finishedAt: summary.finishedAt,
    covered: scoped ? covered : undefined,
  });
  const newFingerprints = new Set([...created, ...reactivated]);
  const newFindings = mergedFindings.filter(f => newFingerprints.has(f.fingerprint));
  const addedRowsByFingerprint = new Map(changed.map(c => [c.fingerprint, c.addedRows]));
  const changedFindings: ChangedFindingDetail[] = mergedFindings
    .filter(f => addedRowsByFingerprint.has(f.fingerprint))
    .map(f => ({ ...f, addedRows: addedRowsByFingerprint.get(f.fingerprint)! }));

  // Persist what this scan actually observed about each rule it ran, so a future "zero findings"
  // can be told apart from "this rule has never successfully run" (spec 030). Grouped by status
  // since every rule sharing an outcome gets the same UPDATE; rules outside this scan's scope
  // (disabled, or excluded by a targeted run) are never touched.
  await setRulesLastRunStatus(successRuleIds, 'success', summary.finishedAt);
  for (const status of ['failed', 'capped', 'invalid'] as const) {
    const ids = incompleteRules.filter(r => r.status === status).map(r => r.ruleId);
    await setRulesLastRunStatus(ids, status, summary.finishedAt);
  }

  // After the sync's transaction has committed. A rule moved to another category leaves findings
  // recorded under its old one, so every category the sync touched is refreshed, not only this one.
  await refreshSnapshotsFor([...new Set([category.id, ...affectedCategories])], opts.now);

  return { summary, newFindings, changedFindings };
}
