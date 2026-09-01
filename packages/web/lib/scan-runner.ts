import {
  runRules,
  runGraphRules,
  runLawRules,
  computeFingerprint,
  computeActivityFingerprint,
  type Finding as CoreFinding,
  type RuleRunEvent,
  type TenantContext,
} from '@rulebeat/core';
import { createTenantContext } from './azure-credential';
import { loadRules, setRulePopulationCounts, setRulesLastRunStatus } from './rules';
import { saveScanResult } from './scan-history';
import { syncScanFindings, dedupeFindingsByFingerprint } from './db/findings';
import { upsertDailySnapshot } from './db/snapshots';
import { SEVERITY_ORDER, emptySeverityCounts } from './severity';
import type { Category, Finding, IncompleteRule, ScanSummary } from './types';

export interface ScanRunOutcome {
  summary: ScanSummary;
  newFindings: Finding[];
}

export interface RunScanOptions {
  triggeredBy?: 'manual' | 'schedule';
  scheduleId?: string;
  /** The schedule_runs execution this category's scan belongs to — links the scan row back to
   *  its run for the unified Run History drill-down. */
  runId?: string;
  ctx?: TenantContext;
  /** Restricts execution to these rule ids within the category (schedules targeting specific
   *  rules/tags). Omitted = every enabled rule in the category (the manual "Run Scan" button). */
  ruleIds?: string[];
  /** Injected by the demo generator so a replayed scan is stamped at its simulated date instead
   *  of the real current time. Every consumer of "when did this scan happen" — the scan row, the
   *  finding lifecycle timestamps, and the daily snapshot it rolls into — is driven from this one
   *  value, so a forward chronological replay produces a real trend history instead of everything
   *  landing on the day the generator happened to run. */
  now?: Date;
}

export async function runCategoryScan(category: Category, opts: RunScanOptions = {}): Promise<ScanRunOutcome> {
  const ctx = opts.ctx ?? await createTenantContext();

  const startedAt = opts.now ?? new Date();
  const findings: Finding[] = [];
  const incompleteRules: IncompleteRule[] = [];

  let enabledRules = loadRules().filter(r => r.enabled && r.category === category.id);
  if (opts.ruleIds) {
    const allowed = new Set(opts.ruleIds);
    enabledRules = enabledRules.filter(r => allowed.has(r.id));
  }
  const totalRules = enabledRules.length;
  const ruleNames = new Map(enabledRules.map(r => [r.id, r.name]));

  const graphRules = enabledRules.filter(r => r.queryBackend === 'microsoft-graph');
  const lawRules = enabledRules.filter(r => r.queryBackend === 'log-analytics');
  const argRules = enabledRules.filter(r => r.queryBackend !== 'microsoft-graph' && r.queryBackend !== 'log-analytics');

  // Only rules whose outcome is 'success' may resolve a prior finding that didn't reappear —
  // 'failed' (the query threw) and 'capped' (a top-level take/top, or ARG-truncated result) are
  // both "real but not proven complete" and must leave their prior findings untouched.
  const successRuleIds: string[] = [];
  // spec 031: population counts from this scan's Applies-to queries, keyed by rule id — independent
  // of a rule's overall success/failed/capped status (see RuleExecutionOutcome.populationCount).
  const populationCounts: Record<string, number> = {};

  // Shared by all three backends' event loops (spec 032/036) — runRules(), runGraphRules(), and
  // runLawRules() all yield the same RuleRunEvent<Finding> contract (per-rule
  // success/failed/capped/invalid outcomes, never a thrown rejection for an individual rule's
  // failure), so one handler keeps the fingerprint/timestamp transform and the
  // success/incomplete/population bookkeeping in exactly one place instead of duplicated per
  // backend. None of the three loops needs a try/catch of its own for the same reason: a bad rule
  // yields a 'failed' outcome event rather than throwing.
  function handleEvent(event: RuleRunEvent<CoreFinding>): void {
    if (event.kind === 'finding') {
      const finding = event.finding;
      // kind:'activity' findings have no resourceId to fingerprint on — they hash ruleId +
      // dimensionKey instead (spec 034), namespaced so it can never collide with a state
      // fingerprint for the same rule. '' is the same empty-dimensionKey convention
      // computeActivityFingerprint()'s own doc comment documents.
      const fingerprint = finding.kind === 'activity'
        ? computeActivityFingerprint(finding.ruleId, finding.dimensionKey ?? '')
        : computeFingerprint(finding.ruleId, finding.resourceId ?? '');
      findings.push({
        ...finding,
        module: category.id,
        fingerprint,
        detectedAt: finding.detectedAt.toISOString(),
      });
      return;
    }
    if (event.outcome.populationCount !== undefined) {
      populationCounts[event.outcome.ruleId] = event.outcome.populationCount;
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
  // Deduped before anything counts, saves, or classifies it — a rule whose ARG query returns the
  // same resource twice in one page (e.g. a fan-out join) must count as one sighting everywhere:
  // the saved scan blob, Run History, notification counts, and the findings lifecycle table.
  const dedupedFindings = dedupeFindingsByFingerprint(findings);
  const counts = emptySeverityCounts();
  for (const f of dedupedFindings) counts[f.severity]++;
  dedupedFindings.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));

  const scanId = crypto.randomUUID();
  const summary: ScanSummary = {
    id: scanId,
    module: category.id,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    subscriptionsScanned: ctx.subscriptionIds,
    findings: dedupedFindings,
    counts,
    totalRules,
    triggeredBy: opts.triggeredBy ?? 'manual',
    coverage: incompleteRules.length > 0 ? 'partial' : 'complete',
    incompleteRules,
  };

  saveScanResult(category.id, summary, { triggeredBy: opts.triggeredBy, scheduleId: opts.scheduleId, id: scanId, runId: opts.runId });

  const { created, reactivated } = await syncScanFindings({
    scanId,
    category: category.id,
    ranRuleIds,
    findings: dedupedFindings,
    finishedAt: summary.finishedAt,
  });
  const newFingerprints = new Set([...created, ...reactivated]);
  const newFindings = dedupedFindings.filter(f => newFingerprints.has(f.fingerprint));

  // Persist what this scan actually observed about each rule it ran, so a future "zero findings"
  // can be told apart from "this rule has never successfully run" (spec 030). Grouped by status
  // since every rule sharing an outcome gets the same UPDATE; rules outside this scan's scope
  // (disabled, or excluded by a targeted run) are never touched.
  setRulesLastRunStatus(successRuleIds, 'success', summary.finishedAt);
  for (const status of ['failed', 'capped', 'invalid'] as const) {
    const ids = incompleteRules.filter(r => r.status === status).map(r => r.ruleId);
    setRulesLastRunStatus(ids, status, summary.finishedAt);
  }
  setRulePopulationCounts(populationCounts);

  upsertDailySnapshot(category.id, opts.now);

  return { summary, newFindings };
}
