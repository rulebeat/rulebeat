/**
 * Findings built by hand, rows and all, for a test that needs many of them or rows a scan could not
 * be made to return. Stored through syncScanFindings(), so they are what a scan leaves.
 */
import { computeFingerprint } from '@rulebeat/core';
import { syncScanFindings } from '@/lib/db/findings';
import type { Finding } from '@/lib/types';

export interface SyntheticOptions {
  ruleId: string;
  category?: string;
  severity?: Finding['severity'];
  subscriptionId?: string;
  resourceGroup?: string;
  location?: string;
}

export function syntheticFinding(name: string, rows: Record<string, unknown>[], opts: SyntheticOptions): Finding & { rows: Record<string, unknown>[] } {
  const subscriptionId = opts.subscriptionId ?? 'sub-1';
  const resourceId = `/subscriptions/${subscriptionId}/resourceGroups/${opts.resourceGroup ?? 'rg-1'}/providers/Microsoft.Compute/virtualMachines/${name}`;
  const category = opts.category ?? 'security';
  return {
    module: category,
    ruleId: opts.ruleId,
    fingerprint: computeFingerprint(opts.ruleId, resourceId),
    severity: opts.severity ?? 'high',
    category: category as Finding['category'],
    resourceId,
    resourceType: 'microsoft.compute/virtualmachines',
    resourceName: name,
    subscriptionId,
    resourceGroup: opts.resourceGroup ?? 'rg-1',
    location: opts.location ?? 'westeurope',
    title: `Finding of ${opts.ruleId}`,
    description: 'test',
    evidence: rows[0] ?? {},
    rows,
    recommendation: 'fix it',
    remediationSteps: [],
    detectedAt: new Date().toISOString(),
  };
}

/** Stores `findings` as one scan of `category` that completed every rule it names. */
export async function storeScan(
  findings: Finding[], opts: { scanId: string; category?: string; finishedAt: string; ranRuleIds?: string[] },
): Promise<void> {
  await syncScanFindings({
    scanId: opts.scanId,
    category: opts.category ?? 'security',
    ranRuleIds: opts.ranRuleIds ?? [...new Set(findings.map(f => f.ruleId))],
    findings,
    finishedAt: opts.finishedAt,
  });
}
