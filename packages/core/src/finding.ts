import { createHash } from 'crypto';
import type { Finding, ModuleCategory, RemediationStep, Severity } from './types.js';

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

  return {
    ...input,
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
  /** What makes this occurrence distinct (e.g. a principal, an IP) — the caller derives this from
   *  its own query result; see computeActivityFingerprint(). Pass '' when the rule has no natural
   *  grouping dimension, which deliberately collapses every occurrence onto one finding. */
  dimensionKey: string;
  subscriptionId: string;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  recommendation: string;
  remediationSteps?: RemediationStep[];
  azurePortalLink?: string;
}

/** sha256(ruleId::activity::dimensionKey), same 16-hex-char truncation as computeFingerprint() —
 *  namespaced with a literal 'activity' segment so a resource finding and an activity finding for
 *  the same rule can never collide even if a resourceId happened to equal some dimensionKey. */
export function computeActivityFingerprint(ruleId: string, dimensionKey: string): string {
  return createHash('sha256').update(`${ruleId}::activity::${dimensionKey}`).digest('hex').slice(0, 16);
}

/** Sibling to createFinding() for kind: 'activity' occurrences (spec 034) — no resourceId/Type/Name,
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
