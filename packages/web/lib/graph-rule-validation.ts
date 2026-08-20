import { buildGraphPath, GRAPH_RESOURCE_PATHS } from '@rulebeat/core';
import type { GraphQuery, TenantContext } from '@rulebeat/core';

/**
 * Hard block, not a UX nicety — this allowlist IS the security boundary for a Directory rule (see
 * its doc comment on GraphResourcePath in packages/core/src/engine/types.ts), so it is checked here
 * unconditionally, before anything touches Azure.
 */
export function isAllowedGraphPath(path: string): path is GraphQuery['path'] {
  return (GRAPH_RESOURCE_PATHS as string[]).includes(path);
}

/**
 * Structural checks on a Graph rule's query shape, mirroring hasCompilableFilter's role for
 * visualQuery/appliesTo: catch a shape that could never produce a real finding before it's saved,
 * rather than discovering it the first time a scan runs. Returns a client-safe error message, or
 * null when the shape is sound.
 */
export function validateGraphQueryShape(gq: GraphQuery): string | null {
  if (!isAllowedGraphPath(gq.path)) {
    return `"${gq.path}" is not one of the Microsoft Graph resource types RuleBeat allows a rule to query.`;
  }
  if (gq.expand) {
    const { arrayField, dateField, itemIdField, resourceType, bands } = gq.expand;
    if (!arrayField?.trim() || !dateField?.trim() || !itemIdField?.trim() || !resourceType?.trim()) {
      return 'Expansion needs an array field, a date field, an item id field, and a resource type.';
    }
    if (!bands || bands.length === 0) {
      return 'Expansion needs at least one severity band.';
    }
  }
  return null;
}

/**
 * Save-time probe for a Graph rule — same fail-open contract as probeRuleIdentitySample
 * (rule-identity-check.ts): a transient Graph/connectivity failure must never newly block a save.
 * Unlike ARG's `| take N`, Graph has no request-level row cap reachable through
 * `TenantContext.graphGet` — a `$top` hint only sets page size, it does not stop `graphGetAll()`
 * from following `@odata.nextLink` to the end of the real result set (and a small `$top` on a large
 * match set makes this *more* expensive, one extra round trip per page). So this probe costs the
 * same as one real scan run of this rule, bounded by the same GRAPH_MAX_ROWS ceiling a scan would
 * hit. It exists to confirm the path/filter combination actually resolves — a bad $filter is
 * otherwise silent until the first real scan. The interactive Validate action (validate-graph route)
 * is where a filter-syntax error is meant to surface to the user; this is a best-effort server log,
 * not a blocking check.
 */
export async function probeGraphQuerySample(gq: GraphQuery, ctx: TenantContext): Promise<void> {
  try {
    await ctx.graphGet(buildGraphPath(gq));
  } catch (err) {
    console.error('[RuleBeat] rule-save Graph probe failed, allowing save:', err);
  }
}
