/**
 * Findings built by hand, rows and all, for a test that needs many of them or rows a scan could not
 * be made to return. Stored through syncScanFindings(), so they are what a scan leaves.
 */
import { computeActivityFingerprint, computeFingerprint } from '@rulebeat/core';
import { syncScanFindings } from '@/lib/db/findings';
import type { Finding } from '@/lib/types';

export interface SyntheticOptions {
  ruleId: string;
  category?: string;
  severity?: Finding['severity'];
  subscriptionId?: string;
  resourceGroup?: string;
  location?: string;
  /**
   * Where the finding sits when it is not a resource. 'directory' builds a finding in the directory: no
   * subscription, no resource group. 'subscription', 'management-group' (named by `managementGroupId`),
   * 'workspace' (a Logs activity finding under the workspace's subscription) and 'unplaceable' build the
   * other places a stored finding can sit.
   */
  placement?: 'directory' | 'subscription' | 'management-group' | 'workspace' | 'unplaceable';
  managementGroupId?: string;
  kind?: Finding['kind'];
}

/** A finding that sits at one of the places a resource does not: built apart so the resource shape stays as it was. */
function placedFinding(name: string, rows: Record<string, unknown>[], opts: SyntheticOptions): Finding & { rows: Record<string, unknown>[] } {
  const category = opts.category ?? 'security';
  const placement = opts.placement!;
  const subscriptionId = placement === 'subscription' || placement === 'workspace' ? opts.subscriptionId ?? 'sub-1' : '';
  const resourceGroup = placement === 'workspace' ? opts.resourceGroup : undefined;
  const managementGroupId = placement === 'management-group' ? opts.managementGroupId ?? 'mg-1' : undefined;
  const resourceId = placement === 'subscription' ? `/subscriptions/${subscriptionId}`
    : placement === 'management-group' ? `/providers/Microsoft.Management/managementGroups/${managementGroupId}`
    : placement === 'unplaceable' ? `/providers/Microsoft.Unknown/things/${name}`
    : undefined;
  const activity = placement === 'workspace';
  return {
    module: category,
    ruleId: opts.ruleId,
    fingerprint: activity ? computeActivityFingerprint(opts.ruleId, name) : computeFingerprint(opts.ruleId, resourceId!),
    severity: opts.severity ?? 'high',
    category: category as Finding['category'],
    kind: activity ? 'activity' : opts.kind,
    ...(activity ? { dimensionKey: name } : { resourceId, resourceName: name, resourceType: 'microsoft.resources/things' }),
    subscriptionId,
    ...(resourceGroup ? { resourceGroup } : {}),
    placement,
    ...(managementGroupId ? { managementGroupId } : {}),
    title: `Finding of ${opts.ruleId}`,
    description: 'test',
    evidence: rows[0] ?? {},
    rows,
    recommendation: 'fix it',
    remediationSteps: [],
    detectedAt: new Date().toISOString(),
  };
}

export function syntheticFinding(name: string, rows: Record<string, unknown>[], opts: SyntheticOptions): Finding & { rows: Record<string, unknown>[] } {
  if (opts.placement && opts.placement !== 'directory') return placedFinding(name, rows, opts);
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
