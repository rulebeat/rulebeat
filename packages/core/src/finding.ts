import { createHash } from 'crypto';
import type { Finding, FindingPlacement, ModuleCategory, RemediationStep, Severity } from './types.js';

export interface ArmPlacement {
  placement: FindingPlacement;
  /** Set only for `management-group`. */
  managementGroupId?: string;
}

const MANAGEMENT_GROUP_ID = /^\/providers\/microsoft\.management\/managementgroups\/([^/]+)/i;

/**
 * Where an Azure Resource Manager finding sits, from what its row says about itself. A subscription
 * and a resource group make it a `resource`; a subscription alone a `subscription`. With no
 * subscription, an id under `/providers/Microsoft.Management/managementGroups/<id>` is a
 * `management-group` finding (and names that group); anything else has no place we can name and is
 * `unplaceable`. Pure and SDK-free: the engine classifies a fresh row with it and the upgrade
 * classifies a stored one, so a finding cannot read one way when it is scanned and another when it is
 * corrected.
 */
export function classifyArmPlacement(input: {
  subscriptionId?: string | null;
  resourceGroup?: string | null;
  resourceId?: string | null;
}): ArmPlacement {
  if (input.subscriptionId) {
    return { placement: input.resourceGroup ? 'resource' : 'subscription' };
  }
  const managementGroupId = input.resourceId?.match(MANAGEMENT_GROUP_ID)?.[1];
  if (managementGroupId) return { placement: 'management-group', managementGroupId };
  return { placement: 'unplaceable' };
}

export interface CreateFindingInput {
  module: string;
  ruleId: string;
  severity: Severity;
  category: ModuleCategory;
  resourceId: string;
  resourceType: string;
  resourceName: string;
  subscriptionId: string;
  resourceGroup?: string;
  location?: string;
  /** Left out, the placement is worked out from the subscription, resource group and resource id
   *  (classifyArmPlacement()). Set by an engine whose findings have no ARM place, such as Graph's. */
  placement?: FindingPlacement;
  managementGroupId?: string;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  recommendation: string;
  remediationSteps?: RemediationStep[];
  estimatedMonthlyCost?: number;
  azurePortalLink?: string;
}

/** Azure resource ids are case-insensitive, and Resource Graph does not always return the same
 *  casing for the same resource across scans (resource group names especially), so the id is
 *  lowercased before hashing. Without that, a casing change resolved the finding and opened a new
 *  one. The finding's own resourceId keeps Azure's casing; only the identity ignores it. Stored
 *  fingerprints from before this change are re-keyed on upgrade (lib/db/fingerprint-rekey.ts). */
export function computeFingerprint(ruleId: string, resourceId: string): string {
  return createHash('sha256').update(`${ruleId}::${resourceId.toLowerCase()}`).digest('hex').slice(0, 16);
}

/** The case-sensitive formula every fingerprint was computed with before computeFingerprint()
 *  started lowercasing. Exists only so the upgrade can recognise, exactly, a stored fingerprint it
 *  is allowed to rewrite. Never use it for a new finding. */
export function computeLegacyFingerprint(ruleId: string, resourceId: string): string {
  return createHash('sha256').update(`${ruleId}::${resourceId}`).digest('hex').slice(0, 16);
}

export function createFinding(input: CreateFindingInput): Finding {
  const fingerprint = computeFingerprint(input.ruleId, input.resourceId);
  const placed: ArmPlacement = input.placement
    ? { placement: input.placement, managementGroupId: input.managementGroupId }
    : classifyArmPlacement(input);

  return {
    ...input,
    ...placed,
    fingerprint,
    remediationSteps: input.remediationSteps ?? [],
    detectedAt: new Date(),
  };
}

export interface CreateActivityFindingInput {
  module: string;
  ruleId: string;
  severity: Severity;
  category: ModuleCategory;
  /** What makes this occurrence distinct (e.g. a principal, an IP). The caller derives this from
   *  its own query result; see computeActivityFingerprint(). Pass '' when the rule has no natural
   *  grouping dimension, which deliberately collapses every occurrence onto one finding. */
  dimensionKey: string;
  /** `workspace` with the workspace's subscription (and resource group), or `unplaceable` with an
   *  empty subscription when the workspace could not be resolved. */
  placement: Extract<FindingPlacement, 'workspace' | 'unplaceable'>;
  subscriptionId: string;
  resourceGroup?: string;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  recommendation: string;
  remediationSteps?: RemediationStep[];
  azurePortalLink?: string;
}

/** sha256(ruleId::activity::dimensionKey), same 16-hex-char truncation as computeFingerprint():
 *  namespaced with a literal 'activity' segment so a resource finding and an activity finding for
 *  the same rule can never collide even if a resourceId happened to equal some dimensionKey. */
export function computeActivityFingerprint(ruleId: string, dimensionKey: string): string {
  return createHash('sha256').update(`${ruleId}::activity::${dimensionKey}`).digest('hex').slice(0, 16);
}

/** Sibling to createFinding() for kind: 'activity' occurrences (spec 034). No resourceId/Type/Name,
 *  because there is no resource. See Finding.kind's doc comment in types.ts. */
export function createActivityFinding(input: CreateActivityFindingInput): Finding {
  const fingerprint = computeActivityFingerprint(input.ruleId, input.dimensionKey);

  return {
    ...input,
    fingerprint,
    kind: 'activity',
    remediationSteps: input.remediationSteps ?? [],
    detectedAt: new Date(),
  };
}
