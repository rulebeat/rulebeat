import { describe, expect, it } from 'vitest';
import { computeFingerprint, createFinding, computeActivityFingerprint, createActivityFinding } from '../src/finding.js';

const baseActivityInput = {
  module: 'identity',
  ruleId: 'rule-1',
  severity: 'high' as const,
  category: 'identity',
  dimensionKey: 'principal:foo@bar.com',
  subscriptionId: 'sub-1',
  title: 'Repeated sign-in from unfamiliar location',
  description: 'desc',
  evidence: { count: 3 },
  recommendation: 'Investigate the principal.',
};

describe('computeActivityFingerprint()', () => {
  it('is stable for the same ruleId + dimensionKey', () => {
    const a = computeActivityFingerprint('rule-1', 'principal:foo@bar.com');
    const b = computeActivityFingerprint('rule-1', 'principal:foo@bar.com');
    expect(a).toBe(b);
  });

  it('differs when dimensionKey differs', () => {
    const a = computeActivityFingerprint('rule-1', 'principal:foo@bar.com');
    const b = computeActivityFingerprint('rule-1', 'principal:baz@bar.com');
    expect(a).not.toBe(b);
  });

  it('differs when ruleId differs', () => {
    const a = computeActivityFingerprint('rule-1', 'principal:foo@bar.com');
    const b = computeActivityFingerprint('rule-2', 'principal:foo@bar.com');
    expect(a).not.toBe(b);
  });

  it('never collides with computeFingerprint() for the same rule + identical key string', () => {
    // Same ruleId, and the activity dimensionKey happens to equal what a resource fingerprint's
    // resourceId would be — the 'activity' namespace segment must still keep these apart.
    const resourceFp = computeFingerprint('rule-1', 'shared-string');
    const activityFp = computeActivityFingerprint('rule-1', 'shared-string');
    expect(activityFp).not.toBe(resourceFp);
  });

  it('collapses every occurrence onto one fingerprint when dimensionKey is the empty-string convention', () => {
    const a = computeActivityFingerprint('rule-1', '');
    const b = computeActivityFingerprint('rule-1', '');
    expect(a).toBe(b);
  });

  it('produces a 16-hex-char fingerprint, matching computeFingerprint()\'s truncation', () => {
    const fp = computeActivityFingerprint('rule-1', 'principal:foo@bar.com');
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('createActivityFinding()', () => {
  it('sets kind to activity', () => {
    const finding = createActivityFinding(baseActivityInput);
    expect(finding.kind).toBe('activity');
  });

  it('never sets resourceId, resourceType, or resourceName', () => {
    const finding = createActivityFinding(baseActivityInput);
    expect(finding.resourceId).toBeUndefined();
    expect(finding.resourceType).toBeUndefined();
    expect(finding.resourceName).toBeUndefined();
  });

  it('carries dimensionKey through onto the finding', () => {
    const finding = createActivityFinding(baseActivityInput);
    expect(finding.dimensionKey).toBe('principal:foo@bar.com');
  });

  it('computes fingerprint the same way computeActivityFingerprint() does', () => {
    const finding = createActivityFinding(baseActivityInput);
    expect(finding.fingerprint).toBe(computeActivityFingerprint('rule-1', 'principal:foo@bar.com'));
  });

  it('defaults remediationSteps to an empty array when omitted', () => {
    const finding = createActivityFinding(baseActivityInput);
    expect(finding.remediationSteps).toEqual([]);
  });

  it('preserves an explicit remediationSteps array', () => {
    const steps = [{ type: 'portal' as const, title: 'Review sign-in logs', content: 'Open Entra ID > Sign-in logs.' }];
    const finding = createActivityFinding({ ...baseActivityInput, remediationSteps: steps });
    expect(finding.remediationSteps).toEqual(steps);
  });

  it('sets detectedAt to a Date', () => {
    const finding = createActivityFinding(baseActivityInput);
    expect(finding.detectedAt).toBeInstanceOf(Date);
  });
});

describe('createFinding() (regression: kind must stay unset for ordinary state findings)', () => {
  it('never sets kind — absence is the "state" default', () => {
    const finding = createFinding({
      module: 'security',
      ruleId: 'rule-1',
      severity: 'high',
      category: 'security',
      resourceId: '/subscriptions/x/resourceGroups/y/providers/z',
      resourceType: 'Microsoft.Storage/storageAccounts',
      resourceName: 'mystorageacct',
      subscriptionId: 'sub-1',
      title: 'Public blob access enabled',
      description: 'desc',
      evidence: {},
      recommendation: 'Disable public access.',
    });
    expect(finding.kind).toBeUndefined();
    expect(finding.dimensionKey).toBeUndefined();
  });
});
