import { createFinding } from '../finding.js';
import { parseDeadline } from '../deadline.js';
import { parseGroupValue } from '../group-value.js';
import { ResourceGraphTruncatedError } from '../clients/resource-graph.js';
import { extractAzureErrorMessage } from '../errors.js';
import type { Finding, TenantContext } from '../types.js';
import { buildRuleQuery, queryHasTopLevelLimit } from './kql.js';
import type { Rule, RuleExecutionStatus, RuleRunEvent } from './types.js';

const IDENTITY_FIELDS = new Set(['id', 'name', 'type', 'location', 'resourceGroup', 'subscriptionId']);

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
        logOutcome('capped', 0, durationMs, `Rule ${rule.id} query truncated: ${extractAzureErrorMessage(err)}`);
        yield { kind: 'outcome', outcome: { ruleId: rule.id, status: 'capped', findingCount: 0 } };
      } else {
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
      // Only an Advisory rule's findings carry a Deadline. A value that does not parse is no
      // Deadline, never a failed rule.
      const deadline = rule.kind === 'advisory' && rule.deadlineField
        ? parseDeadline(resource[rule.deadlineField]) ?? undefined
        : undefined;
      // Same for the group: a blank or missing value is no group, never a failed rule.
      const groupValue = rule.kind === 'advisory' && rule.groupField
        ? parseGroupValue(resource[rule.groupField]) ?? undefined
        : undefined;
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
          ...(deadline ? { deadline } : {}),
          ...(groupValue ? { groupValue } : {}),
        }),
      };
    }

    // 'invalid' takes precedence over 'capped' when both apply — a bad identity is the more
    // actionable problem to surface, and both already exclude resolving prior findings.
    const status: RuleExecutionStatus = invalidRowCount > 0 ? 'invalid' : capped ? 'capped' : 'success';
    const findingCount = resources.length - invalidRowCount;
    const message = invalidRowCount > 0
      ? `Rule ${rule.id} completed: ${status} (${findingCount} finding(s), ${invalidRowCount} row(s) with no resource id)`
      : `Rule ${rule.id} completed: ${status} (${findingCount} finding(s))`;
    logOutcome(status, findingCount, queryDurationMs, message);
    yield { kind: 'outcome', outcome: { ruleId: rule.id, status, findingCount } };
  }
}
