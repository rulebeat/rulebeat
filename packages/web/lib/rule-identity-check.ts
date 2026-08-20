import type { TenantContext } from '@rulebeat/core';

// Shared identity contract between validate-kql, the rule-save routes, and (in spirit — the core
// package has its own copy) runner.ts: a row is identity-less when its `id` column is missing,
// null, non-string, or whitespace-only. Keeping this in one place means "invalid" can't drift
// between where a rule is checked before saving and where it's actually scored at scan time.
export function checkRowsHaveIdentity(rows: Record<string, unknown>[]): { valid: boolean; invalidCount: number } {
  const invalidCount = rows.filter(row => String(row['id'] ?? '').trim() === '').length;
  return { valid: invalidCount === 0, invalidCount };
}

/**
 * Save-time guard for a `rawKql` rule: samples up to 5 rows the same way `validate-kql` does and
 * blocks only when that sample confirms identity-less rows. Any other failure (Azure unreachable,
 * no credential configured yet, a query error unrelated to row shape) fails OPEN — the save is
 * allowed to proceed — because a transient Azure blip must not newly block rule editing. This is
 * a deterrent, not the safety boundary: `runner.ts`'s own per-row filtering at scan time is what
 * actually protects a row that this 5-row sample didn't happen to catch.
 */
export async function probeRuleIdentitySample(
  rawKql: string,
  ctx: TenantContext,
): Promise<{ blocked: boolean; invalidCount?: number; sampleSize?: number }> {
  const limitedKql = /\|\s*(take|limit|top)\s+\d+/i.test(rawKql)
    ? rawKql
    : `${rawKql.trim()}\n| take 5`;
  try {
    const rows = await ctx.queryARG<Record<string, unknown>>(limitedKql);
    const identity = checkRowsHaveIdentity(rows);
    return identity.valid
      ? { blocked: false }
      : { blocked: true, invalidCount: identity.invalidCount, sampleSize: rows.length };
  } catch (err) {
    console.error('[RuleBeat] rule-save identity probe failed, allowing save:', err);
    return { blocked: false };
  }
}
