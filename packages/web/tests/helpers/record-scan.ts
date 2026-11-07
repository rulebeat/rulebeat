/**
 * A finished scan saved the way a scan save does, for a test that needs live posture to count a rule as passing:
 * formula v3 counts a rule passing only when the newest covering scan ran it to the end (#402), not when the
 * rule's own last run status says so.
 */
import { saveScanResult } from '@/lib/scan-history';
import { EVERYTHING_COVERED } from '@/lib/run-scope';
import { emptySeverityCounts } from '@/lib/severity';
import type { ScanSummary } from '@/lib/types';

export async function recordScan(
  category: string,
  opts: { ranRuleIds: string[]; incompleteRuleIds?: string[]; finishedAt?: string; id?: string; subscriptionsScanned?: string[] },
): Promise<void> {
  const finishedAt = opts.finishedAt ?? new Date().toISOString();
  const id = opts.id ?? `scan-${category}-${finishedAt}`;
  const incompleteRules: ScanSummary['incompleteRules'] = (opts.incompleteRuleIds ?? []).map(ruleId => ({ ruleId, ruleName: ruleId, status: 'failed' }));
  await saveScanResult(category, {
    id, module: category, startedAt: finishedAt, finishedAt, durationMs: 1000,
    subscriptionsScanned: opts.subscriptionsScanned ?? ['sub-1'], findings: [], counts: emptySeverityCounts(),
    totalRules: opts.ranRuleIds.length, triggeredBy: 'manual',
    coverage: incompleteRules.length > 0 ? 'partial' : 'complete', incompleteRules,
  }, { id, coveredScope: EVERYTHING_COVERED, ranRuleIds: opts.ranRuleIds });
}
