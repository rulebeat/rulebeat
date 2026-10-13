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
  /** 'directory' builds a finding that sits in the directory: no subscription, no resource group. */
  placement?: 'directory';
  kind?: Finding['kind'];
}

export function syntheticFinding(name: string, rows: Record<string, unknown>[], opts: SyntheticOptions): Finding & { rows: Record<string, unknown>[] } {
  const directory = opts.placement === 'directory';
  const subscriptionId = directory ? '' : opts.subscriptionId ?? 'sub-1';
  const resourceGroup = directory ? undefined : opts.resourceGroup ?? 'rg-1';
  const resourceId = directory
    ? `applications/${name}`
    : `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Compute/virtualMachines/${name}`;
  const category = opts.category ?? 'security';
  return {
    module: category,
    ruleId: opts.ruleId,
    fingerprint: computeFingerprint(opts.ruleId, resourceId),
    severity: opts.severity ?? 'high',
    category: category as Finding['category'],
    resourceId,
    ...(opts.kind ? { kind: opts.kind } : {}),
    resourceType: directory ? 'microsoft.graph/applications' : 'microsoft.compute/virtualmachines',
    resourceName: name,
    subscriptionId,
    resourceGroup,
    placement: directory ? 'directory' : 'resource',
    location: directory ? undefined : opts.location ?? 'westeurope',
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
