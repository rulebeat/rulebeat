import { createFinding } from '../finding.js';
import { GraphTruncatedError } from '../auth/index.js';
import { extractAzureErrorMessage } from '../errors.js';
import type { Finding, TenantContext } from '../types.js';
import type { GraphExpandConfig, GraphQuery, Rule, RuleExecutionStatus, RuleRunEvent } from './types.js';

// Mirrors identity-scan.ts's daysUntil() exactly — ceil so "expires in the next few hours" still
// reads as 1 day remaining, not 0.
function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

// First band (array order, tightest-first by convention) whose maxDays the item's remaining days
// falls under. undefined means the item sits outside every band's window — not yet worth a
// finding, mirroring identity-scan.ts's `if (days > WARN_DAYS) continue`.
function severityForBands(days: number, bands: GraphExpandConfig['bands']) {
  for (const band of bands) {
    if (days <= band.maxDays) return band.severity;
  }
  return undefined;
}

// Builds the Graph request path for a rule's query: the allowlisted resource path, an explicit
// $select when expand is set (so the array field this rule expands is guaranteed present rather
// than relying on Graph's default per-resource-type property set), and the rule's own $filter if
// any. Literal commas in $select, not %2C — matches how every hand-written Graph query already
// reads elsewhere in this codebase (see the identity-scan.ts query this engine replaces).
export function buildGraphPath(gq: GraphQuery): string {
  const parts: string[] = [];
  if (gq.expand) {
    const select = ['id', 'displayName', gq.expand.arrayField];
    // appId is Applications-specific (the app registration's client id, distinct from its Graph
    // object id) — only requested for that one path, since Graph rejects a $select naming a
    // property that doesn't exist on the requested resource type.
    if (gq.path === 'applications') select.push('appId');
    parts.push(`$select=${select.join(',')}`);
  }
  if (gq.filter) parts.push(`$filter=${encodeURIComponent(gq.filter)}`);
  return parts.length ? `/${gq.path}?${parts.join('&')}` : `/${gq.path}`;
}

// Reproduces identity-scan.ts's one verified real portal deep link (the AAD app registration
// credentials blade, keyed on appId — not the Graph object id). The other 6 allowlisted paths have
// no equivalent verified link, so a generic Graph finding gets no azurePortalLink rather than a
// guessed URL that might not resolve.
function graphPortalLink(gq: GraphQuery, parent: Record<string, unknown>): string | undefined {
  if (gq.path === 'applications' && gq.expand) {
    return `https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/Credentials/appId/${String(parent['appId'] ?? '')}`;
  }
  return undefined;
}

// Graph-backend counterpart to runRules() (spec 032) — same RuleRunEvent/RuleExecutionStatus
// contract, but Graph-shaped internals: no parseResourceId() (there is no ARM id to parse), no ARG
// enrichment follow-up query, ctx.graphGet() instead of ctx.queryARG(). A per-rule try/catch keeps
// one bad rule's failure from aborting every other Graph rule in the same scan (closes RB-RM-011).
export async function* runGraphRules(
  rules: Rule[],
  ctx: TenantContext,
): AsyncIterable<RuleRunEvent<Finding>> {
  const enabled = rules.filter(r => r.enabled);

  for (const rule of enabled) {
    ctx.log(`Running rule: ${rule.name}`, { operation: 'rule-start', ruleId: rule.id, category: rule.category });

    // One consistent log line right before every outcome is yielded, for every status including
    // 'success' — mirrors runner.ts's logOutcome exactly, same operation names, so a scan's log is
    // one coherent per-rule audit trail regardless of which backend a rule runs on.
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

    const gq = rule.graphQuery;
    if (!gq) {
      // Defensive only — POST/PUT require graphQuery for a microsoft-graph rule, so a null one
      // here means stored data drifted from that invariant, not a normal runtime path.
      logOutcome('failed', 0, 0, `Rule ${rule.id} has no Graph query configured.`);
      yield { kind: 'outcome', outcome: { ruleId: rule.id, status: 'failed', findingCount: 0 } };
      continue;
    }

    const path = buildGraphPath(gq);
    const queryStartedAt = Date.now();
    let objects: Record<string, unknown>[];
    try {
      if (!ctx.graphGet) {
        // TenantContext.graphGet is required by its type, but fakeTenantContext()'s omitGraphGet
        // fixture deliberately violates that at runtime (via a cast) to exercise this exact path.
        throw new Error('This tenant context has no Graph access configured.');
      }
      objects = await ctx.graphGet<Record<string, unknown>>(path);
    } catch (err) {
      const durationMs = Date.now() - queryStartedAt;
      // A truncated Graph result set is real data RuleBeat itself flagged as incomplete (Graph has
      // no self-reported truncation signal the way ARG does) — 'capped', not 'failed', mirroring
      // runner.ts's ResourceGraphTruncatedError handling. Either way it must never resolve this
      // rule's prior findings, which is why both land in the same catch.
      if (err instanceof GraphTruncatedError) {
        logOutcome('capped', 0, durationMs, `Rule ${rule.id} query truncated: ${extractAzureErrorMessage(err)}`);
        yield { kind: 'outcome', outcome: { ruleId: rule.id, status: 'capped', findingCount: 0 } };
      } else {
        logOutcome('failed', 0, durationMs, `Rule ${rule.id} query failed: ${extractAzureErrorMessage(err)}`);
        yield { kind: 'outcome', outcome: { ruleId: rule.id, status: 'failed', findingCount: 0 } };
      }
      continue;
    }
    const queryDurationMs = Date.now() - queryStartedAt;

    // A row with no usable id can't produce a real finding — no portal link, no stable fingerprint
    // (computeFingerprint hashes ruleId::resourceId, so a blank id collapses every such row onto
    // one record). Skip yielding those rows and downgrade the outcome, mirroring runner.ts's
    // identity-less-row handling (spec 005) exactly.
    let invalidRowCount = 0;
    let findingCount = 0;

    for (const obj of objects) {
      const objectId = String(obj['id'] ?? '');
      if (objectId.trim() === '') {
        invalidRowCount++;
        continue;
      }
      const resourceName = String(obj['displayName'] ?? objectId);

      if (gq.expand) {
        const items = obj[gq.expand.arrayField];
        if (!Array.isArray(items)) continue; // nothing to expand on this particular object
        for (const item of items as Record<string, unknown>[]) {
          const rawDate = item[gq.expand.dateField];
          if (typeof rawDate !== 'string' || !rawDate) continue;
          const days = daysUntil(rawDate);
          const severity = severityForBands(days, gq.expand.bands);
          if (!severity) continue;

          const itemId = String(item[gq.expand.itemIdField] ?? '');
          const resourceId = `${gq.path}/${objectId}/${gq.expand.arrayField}/${itemId}`;
          findingCount++;
          yield {
            kind: 'finding',
            finding: createFinding({
              module: 'rule-engine',
              ruleId: rule.id,
              severity,
              category: rule.category,
              resourceId,
              resourceType: gq.expand.resourceType,
              resourceName,
              subscriptionId: ctx.subscriptionIds[0] ?? '',
              title: rule.name,
              description: rule.description,
              evidence: { ...item, daysRemaining: days },
              recommendation: rule.description,
              remediationSteps: rule.remediationSteps ?? [],
              azurePortalLink: graphPortalLink(gq, obj),
            }),
          };
        }
      } else {
        findingCount++;
        yield {
          kind: 'finding',
          finding: createFinding({
            module: 'rule-engine',
            ruleId: rule.id,
            severity: rule.severity,
            category: rule.category,
            resourceId: `${gq.path}/${objectId}`,
            resourceType: `microsoft.graph/${gq.path}`,
            resourceName,
            subscriptionId: ctx.subscriptionIds[0] ?? '',
            title: rule.name,
            description: rule.description,
            evidence: obj,
            recommendation: rule.description,
            remediationSteps: rule.remediationSteps ?? [],
          }),
        };
      }
    }

    const status: RuleExecutionStatus = invalidRowCount > 0 ? 'invalid' : 'success';
    const message = invalidRowCount > 0
      ? `Rule ${rule.id} completed: ${status} (${findingCount} finding(s), ${invalidRowCount} row(s) with no resource id)`
      : `Rule ${rule.id} completed: ${status} (${findingCount} finding(s))`;
    logOutcome(status, findingCount, queryDurationMs, message);
    yield { kind: 'outcome', outcome: { ruleId: rule.id, status, findingCount } };
  }
}
