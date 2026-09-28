import type { TenantContext } from '@rulebeat/core';

// Kept apart from ./live-context.ts so the scan path can recognise a Demo's tenant without loading
// the synthetic estate on every real install.

/** Why a rule did not run in a Demo. Shown in Run History, so it is written for the Visitor. */
export const DEMO_UNANSWERED_RULE_REASON =
  'A Demo only has data for the rules it ships with, so a new or edited rule has nothing to run against.';

/** A tenant context that counts the queries it had no data for. */
export interface CountsUnansweredQueries {
  unansweredQueries: () => number;
}

/** How many queries `ctx` could not answer, or 0 for any context that is not a Demo's. */
export function unansweredDemoQueries(ctx: TenantContext): number {
  const count = (ctx as Partial<CountsUnansweredQueries>).unansweredQueries;
  return typeof count === 'function' ? count() : 0;
}
