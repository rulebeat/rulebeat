import type { LogAnalyticsQuery, TenantContext } from '@rulebeat/core';

// Two years — a reasonable outer bound on LAW retention rather than an arbitrary guess (spec 036).
const MAX_TIME_WINDOW_DAYS = 730;

/**
 * Structural checks on a Log Analytics rule's query shape, mirroring validateGraphQueryShape's role:
 * catch a shape that could never produce a real finding before it's saved, rather than discovering it
 * the first time a scan runs. Returns a client-safe error message, or null when the shape is sound.
 */
export function validateLogAnalyticsQueryShape(lq: LogAnalyticsQuery): string | null {
  if (!lq.kql?.trim()) {
    return 'A Log Analytics rule needs a KQL query.';
  }
  if (!Number.isFinite(lq.timeWindowDays) || !Number.isInteger(lq.timeWindowDays) || lq.timeWindowDays < 1 || lq.timeWindowDays > MAX_TIME_WINDOW_DAYS) {
    return `Time window must be a whole number of days between 1 and ${MAX_TIME_WINDOW_DAYS}.`;
  }
  if (lq.dimensionKeyField !== undefined && !lq.dimensionKeyField.trim()) {
    return 'Dimension key field cannot be blank — leave it unset to collapse every occurrence onto one finding.';
  }
  return null;
}

/**
 * Save-time probe for a Log Analytics rule — same fail-open contract as probeGraphQuerySample: a
 * transient Log Analytics failure, or no workspace configured yet, must never newly block a save.
 * The interactive Validate action (validate-logs route) is where a real query error is meant to
 * surface to the user; this is a best-effort server log, not a blocking check.
 */
export async function probeLogAnalyticsQuerySample(lq: LogAnalyticsQuery, ctx: TenantContext): Promise<void> {
  try {
    await ctx.queryLogs(lq.kql);
  } catch (err) {
    console.error('[RuleBeat] rule-save Log Analytics probe failed, allowing save:', err);
  }
}
