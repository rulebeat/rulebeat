import { createFinding } from '../finding.js';
import { ResourceGraphTruncatedError } from '../clients/resource-graph.js';
import { extractAzureErrorMessage } from '../errors.js';
import type { Finding, TenantContext } from '../types.js';
import { buildPopulationQuery, buildRuleQuery, queryHasTopLevelLimit } from './kql.js';
import type { Rule, RuleExecutionStatus, RuleRunEvent } from './types.js';

const IDENTITY_FIELDS = new Set(['id', 'name', 'type', 'location', 'resourceGroup', 'subscriptionId']);

// Ranks RuleExecutionStatus from most to least trustworthy, so a rule's violation-query outcome
// and its independent Applies-to population-query outcome (spec 031) combine into one overall
// status: 'success' only if both are 'success', 'failed' if either failed, otherwise the worse of
// the two. Mirrors the existing invalid-beats-capped precedent below, generalized to two sources.
const STATUS_SEVERITY: Record<RuleExecutionStatus, number> = { failed: 3, invalid: 2, capped: 1, success: 0 };
function worseStatus(a: RuleExecutionStatus, b: RuleExecutionStatus): RuleExecutionStatus {
  return STATUS_SEVERITY[a] >= STATUS_SEVERITY[b] ? a : b;
}

interface PopulationResult { status: RuleExecutionStatus; count?: number }

// Runs Rule.appliesTo's count query, if the rule declares one. A rule with no appliesTo (every
// 'detect'-shape rule — still the common case) contributes a neutral 'success' with no count, so
// worseStatus() below is a no-op and the outcome carries no populationCount, unchanged from today.
async function runPopulationQuery(
  rule: Rule,
  ctx: TenantContext,
  scope: { subscriptions?: string[]; managementGroups?: string[] },
): Promise<PopulationResult> {
  if (!rule.appliesTo) return { status: 'success' };
  const kql = buildPopulationQuery(rule.appliesTo, rule);
  const capped = queryHasTopLevelLimit(kql);
  try {
    const rows = await ctx.queryARG<Record<string, unknown>>(kql, scope);
    // ARG's `| count` operator names its single result column 'Count' (capital C).
    const raw = rows[0]?.['Count'] ?? rows[0]?.['count'];
    const count = typeof raw === 'number' ? raw : Number(raw ?? 0);
    return { status: capped ? 'capped' : 'success', count };
  } catch (err) {
    if (err instanceof ResourceGraphTruncatedError) {
      ctx.log(`Rule ${rule.id} population query truncated: ${extractAzureErrorMessage(err)}`, {
        operation: 'rule-population-outcome', ruleId: rule.id, category: rule.category, level: 'info',
      });
      return { status: 'capped' };
    }
    ctx.log(`Rule ${rule.id} population query failed: ${extractAzureErrorMessage(err)}`, {
      operation: 'rule-population-outcome', ruleId: rule.id, category: rule.category, level: 'error',
    });
    return { status: 'failed' };
  }
}

// rawKql rules (e.g. every APRL rule) write their own `| project` clause and often only include
// the columns their query actually needs (id, name, tags, ...) — type/resourceGroup/subscriptionId
// are silently dropped since ARG only returns projected columns. Those three (unlike location) are
// always encoded in the ARM resource id itself, so parse them back out as a fallback rather than
// leaving the finding with blank identity fields.
function parseResourceId(id: string): { subscriptionId?: string; resourceGroup?: string; resourceType?: string } {
  const subMatch = id.match(/\/subscriptions\/([^/]+)/i);
  const rgMatch = id.match(/\/resourceGroups\/([^/]+)/i);
  const provMatch = id.match(/\/providers\/([^/]+)\/(.+)$/i);
  let resourceType: string | undefined;
  if (provMatch?.[1] && provMatch[2]) {
    const namespace = provMatch[1];
    const segments = provMatch[2].split('/');
    const typeParts: string[] = [];
    for (let i = 0; i + 1 < segments.length; i += 2) typeParts.push(segments[i]!);
    resourceType = typeParts.length ? `${namespace}/${typeParts.join('/')}` : namespace;
  }
  return { subscriptionId: subMatch?.[1], resourceGroup: rgMatch?.[1], resourceType };
}

export async function* runRules(
  rules: Rule[],
  ctx: TenantContext,
): AsyncIterable<RuleRunEvent<Finding>> {
  const enabled = rules.filter(r => r.enabled);

  for (const rule of enabled) {
    ctx.log(`Running rule: ${rule.name}`, { operation: 'rule-start', ruleId: rule.id, category: rule.category });

    // rawKql is used as-is; otherwise build the query from the rule definition.
    // Conditions are emitted as violation | where clauses — ARG returns only violating resources.
    const kql = rule.rawKql ?? buildRuleQuery(rule);
    const capped = queryHasTopLevelLimit(kql);

    // Per-rule execution scope: use subscriptions/MGs defined on the rule, or tenant-wide.
    const scope = {
      subscriptions: rule.scope.subscriptions?.length ? rule.scope.subscriptions : undefined,
      managementGroups: rule.scope.managementGroups?.length ? rule.scope.managementGroups : undefined,
    };

    // One consistent log line right before every outcome is yielded, for every status including
    // 'success' — a full scan's log is then a complete per-rule audit trail, not just the failures.
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

    let resources: Record<string, unknown>[];
    // Measured around ctx.queryARG() specifically, captured before the enrichment/finding-yield
    // loop runs — not at the point the outcome is finally yielded, since the async generator pauses
    // at every `yield` waiting on its consumer, and that pause time is not query time.
    const queryStartedAt = Date.now();
    try {
      resources = await ctx.queryARG<Record<string, unknown>>(kql, scope);
    } catch (err) {
      const durationMs = Date.now() - queryStartedAt;
      // A truncated Resource Graph result set is real data that Azure itself flagged as
      // incomplete — 'capped', not 'failed', so the UI can say why rather than just "errored".
      // Either way it must never resolve this rule's prior findings, which is why both land in
      // the same try/catch: neither path yielded a trustworthy, exhaustive result.
      if (err instanceof ResourceGraphTruncatedError) {
        // 'capped', unlike 'failed' below, doesn't automatically dominate every population
        // outcome — a failed population query would still make the combined result 'failed' — so
        // the population query still runs and gets folded in here rather than skipped.
        const population = await runPopulationQuery(rule, ctx, scope);
        const status = worseStatus('capped', population.status);
        logOutcome(status, 0, durationMs, `Rule ${rule.id} query truncated: ${extractAzureErrorMessage(err)}`);
        yield {
          kind: 'outcome',
          outcome: {
            ruleId: rule.id, status, findingCount: 0,
            ...(population.count !== undefined ? { populationCount: population.count } : {}),
          },
        };
      } else {
        // 'failed' already outranks every possible population outcome in worseStatus() below, so
        // the combined result can't change — skip the round-trip on an already-known answer.
        logOutcome('failed', 0, durationMs, `Rule ${rule.id} query failed: ${extractAzureErrorMessage(err)}`);
        yield { kind: 'outcome', outcome: { ruleId: rule.id, status: 'failed', findingCount: 0 } };
      }
      continue;
    }
    const queryDurationMs = Date.now() - queryStartedAt;

    // Identity enrichment: some resources came back missing type/location/resourceGroup/
    // subscriptionId because the rule's own `| project` clause never selected them (true for
    // every APRL rule, which only projects the columns its specific check needs). Rather than
    // rewriting the rule's KQL (risky — a query with joins/summarize may have genuinely dropped
    // those columns upstream, and forcing them back in could break the query outright), run one
    // small follow-up query against the base `resources` table for just the affected ids. This is
    // the only path that can recover `location`, which — unlike the other three — isn't encoded
    // anywhere in the ARM resource id string and so can't be parsed back out for free.
    const missingIds = [...new Set(
      resources
        .filter(r => !r['type'] || !r['location'] || !r['resourceGroup'] || !r['subscriptionId'])
        .map(r => String(r['id'] ?? ''))
        .filter(Boolean),
    )];
    let enrichment = new Map<string, Record<string, unknown>>();
    if (missingIds.length > 0) {
      try {
        const idList = missingIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ');
        const rows = await ctx.queryARG<Record<string, unknown>>(
          `resources\n| where id in (${idList})\n| project id, type, location, resourceGroup, subscriptionId`,
          scope,
        );
        enrichment = new Map(rows.map(r => [String(r['id'] ?? ''), r]));
      } catch (err) {
        ctx.log(`Identity enrichment query failed for rule ${rule.id}: ${extractAzureErrorMessage(err)}`, {
          operation: 'enrichment-failed', ruleId: rule.id, category: rule.category, level: 'warn',
        });
      }
    }

    // A row with no usable id can't produce a real finding — no portal link, no stable
    // fingerprint (computeFingerprint hashes ruleId::resourceId, so a blank id collapses every
    // such row onto one record that then gets silently overwritten scan after scan). Skip
    // yielding those rows rather than pretending they're findings, and downgrade the outcome so
    // the rule's otherwise-real result isn't mistaken for a complete, trustworthy pass.
    let invalidRowCount = 0;
    for (const resource of resources) {
      const resourceId = String(resource['id'] ?? '');
      if (resourceId.trim() === '') {
        invalidRowCount++;
        continue;
      }
      const evidence = Object.fromEntries(
        Object.entries(resource).filter(([k]) => !IDENTITY_FIELDS.has(k)),
      );
      const enriched = enrichment.get(resourceId);
      const fallback = parseResourceId(resourceId);
      const pick = (argKey: string, fallbackVal: string | undefined) =>
        resource[argKey] ?? enriched?.[argKey] ?? fallbackVal;
      const optStr = (v: unknown) => (v != null ? String(v) : undefined);
      yield {
        kind: 'finding',
        finding: createFinding({
          module: 'rule-engine' as const,
          severity: rule.severity,
          category: rule.category,
          resourceId,
          resourceType: String(pick('type', fallback.resourceType) ?? ''),
          resourceName: String(resource['name'] ?? ''),
          subscriptionId: String(pick('subscriptionId', fallback.subscriptionId) ?? ''),
          resourceGroup: optStr(pick('resourceGroup', fallback.resourceGroup)),
          location: optStr(resource['location'] ?? enriched?.['location']),
          title: rule.name,
          ruleId: rule.id,
          description: rule.description,
          evidence,
          recommendation: rule.description,
          remediationSteps: rule.remediationSteps ?? [],
          azurePortalLink: `https://portal.azure.com/#@/resource${resourceId}`,
        }),
      };
    }

    // 'invalid' takes precedence over 'capped' when both apply — a bad identity is the more
    // actionable problem to surface, and both already exclude resolving prior findings. Neither
    // dominates a failed/capped Applies-to population query, so that combines in via worseStatus()
    // same as every other branch above.
    const violationStatus = invalidRowCount > 0 ? 'invalid' : capped ? 'capped' : 'success';
    const population = await runPopulationQuery(rule, ctx, scope);
    const status = worseStatus(violationStatus, population.status);
    const findingCount = resources.length - invalidRowCount;
    const message = invalidRowCount > 0
      ? `Rule ${rule.id} completed: ${status} (${findingCount} finding(s), ${invalidRowCount} row(s) with no resource id)`
      : `Rule ${rule.id} completed: ${status} (${findingCount} finding(s))`;
    logOutcome(status, findingCount, queryDurationMs, message);
    yield {
      kind: 'outcome',
      outcome: {
        ruleId: rule.id, status, findingCount,
        ...(population.count !== undefined ? { populationCount: population.count } : {}),
      },
    };
  }
}
