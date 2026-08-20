import { createActivityFinding } from '../finding.js';
import { LogAnalyticsTruncatedError } from '../clients/log-analytics.js';
import { extractAzureErrorMessage } from '../errors.js';
import type { Finding, TenantContext } from '../types.js';
import type { Rule, RuleExecutionStatus, RuleRunEvent } from './types.js';

// Log Analytics-backend counterpart to runRules()/runGraphRules() (spec 036) — same
// RuleRunEvent/RuleExecutionStatus contract, but LAW-shaped internals: no path-building (the
// rule's own KQL is the whole query), no ARG/Graph-style pagination (queryLogAnalyticsWorkspace()
// is single-shot), and findings are 'activity' kind (no resourceId — see Finding.kind's doc
// comment in types.ts) rather than 'state'. No per-row severity banding in v1 (out of scope, see
// spec 036) — every row from a rule takes that rule's own configured severity. A per-rule
// try/catch keeps one bad rule's failure from aborting every other Log Analytics rule in the same
// scan, same isolation graph-runner.ts and runner.ts already give their own backends.
export async function* runLawRules(
  rules: Rule[],
  ctx: TenantContext,
): AsyncIterable<RuleRunEvent<Finding>> {
  const enabled = rules.filter(r => r.enabled);

  for (const rule of enabled) {
    ctx.log(`Running rule: ${rule.name}`, { operation: 'rule-start', ruleId: rule.id, category: rule.category });

    // One consistent log line right before every outcome is yielded, for every status including
    // 'success' — mirrors runner.ts/graph-runner.ts's logOutcome exactly, same operation names, so
    // a scan's log is one coherent per-rule audit trail regardless of which backend a rule runs on.
    const logOutcome = (status: RuleExecutionStatus, findingCount: number, durationMs: number, message: string) => {
      ctx.log(message, {
        operation: 'rule-outcome',
        ruleId: rule.id,
        category: rule.category,
        status,
        findingCount,
        durationMs,
        level: status === 'failed' ? 'error' : 'info',
      });
    };

    const lq = rule.logsQuery;
    if (!lq) {
      // Defensive only — POST/PUT require logsQuery for a log-analytics rule, so a null one here
      // means stored data drifted from that invariant, not a normal runtime path.
      logOutcome('failed', 0, 0, `Rule ${rule.id} has no Log Analytics query configured.`);
      yield { kind: 'outcome', outcome: { ruleId: rule.id, status: 'failed', findingCount: 0 } };
      continue;
    }

    const queryStartedAt = Date.now();
    let rows: Record<string, unknown>[];
    try {
      // ctx.queryLogs is required (not optional) on TenantContext, unlike graphGet — no fake-azure
      // fixture exercises an "omitted" path here, so there is no defensive existence check to mirror
      // graph-runner.ts's `if (!ctx.graphGet)`.
      rows = await ctx.queryLogs<Record<string, unknown>>(lq.kql);
    } catch (err) {
      const durationMs = Date.now() - queryStartedAt;
      // A truncated (PartialFailure) result is real data RuleBeat itself flagged as incomplete —
      // 'capped', not 'failed', mirroring runner.ts/graph-runner.ts's truncation handling. Any other
      // failure, including "no workspace configured" (LogAnalyticsNotConfiguredError already carries
      // its own clear, actionable message), lands as 'failed'. Either way this must never resolve
      // this rule's prior findings.
      if (err instanceof LogAnalyticsTruncatedError) {
        logOutcome('capped', 0, durationMs, `Rule ${rule.id} query truncated: ${extractAzureErrorMessage(err)}`);
        yield { kind: 'outcome', outcome: { ruleId: rule.id, status: 'capped', findingCount: 0 } };
      } else {
        logOutcome('failed', 0, durationMs, `Rule ${rule.id} query failed: ${extractAzureErrorMessage(err)}`);
        yield { kind: 'outcome', outcome: { ruleId: rule.id, status: 'failed', findingCount: 0 } };
      }
      continue;
    }
    const queryDurationMs = Date.now() - queryStartedAt;

    // A configured dimensionKeyField whose value is blank on a given row can't produce a real
    // per-occurrence finding — skip it and downgrade the outcome, mirroring runner.ts/graph-runner.ts's
    // identity-less-row handling (spec 005/032) exactly. With no dimensionKeyField configured at all,
    // every row deliberately shares dimensionKey '' (see LogAnalyticsQuery's doc comment) and this
    // check never applies.
    let invalidRowCount = 0;
    let findingCount = 0;

    for (const row of rows) {
      let dimensionKey = '';
      if (lq.dimensionKeyField) {
        dimensionKey = String(row[lq.dimensionKeyField] ?? '').trim();
        if (dimensionKey === '') {
          invalidRowCount++;
          continue;
        }
      }

      findingCount++;
      yield {
        kind: 'finding',
        finding: createActivityFinding({
          module: 'rule-engine',
          ruleId: rule.id,
          severity: rule.severity,
          category: rule.category,
          dimensionKey,
          subscriptionId: ctx.subscriptionIds[0] ?? '',
          title: rule.name,
          description: rule.description,
          evidence: row,
          recommendation: rule.description,
          remediationSteps: rule.remediationSteps ?? [],
        }),
      };
    }

    const status: RuleExecutionStatus = invalidRowCount > 0 ? 'invalid' : 'success';
    const message = invalidRowCount > 0
      ? `Rule ${rule.id} completed: ${status} (${findingCount} finding(s), ${invalidRowCount} row(s) with no usable dimension value)`
      : `Rule ${rule.id} completed: ${status} (${findingCount} finding(s))`;
    logOutcome(status, findingCount, queryDurationMs, message);
    yield { kind: 'outcome', outcome: { ruleId: rule.id, status, findingCount } };
  }
}
