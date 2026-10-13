import { describe, expect, it } from 'vitest';
import { classifyArmPlacement, computeFingerprint, createFinding, computeActivityFingerprint, createActivityFinding } from '../src/finding.js';

const baseActivityInput = {
  module: 'identity',
  ruleId: 'rule-1',
  severity: 'high' as const,
  category: 'identity',
  dimensionKey: 'principal:foo@bar.com',
  placement: 'workspace' as const,
  subscriptionId: 'sub-1',
  title: 'Repeated sign-in from unfamiliar location',
  description: 'desc',
  evidence: { count: 3 },
  recommendation: 'Investigate the principal.',
};

describe('computeFingerprint()', () => {
  const id = (rg: string) => `/subscriptions/sub-1/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/vm-1`;

  it('treats resource ids that differ only in casing as the same resource, as Azure does', () => {
    expect(computeFingerprint('rule-1', id('RG-APP'))).toBe(computeFingerprint('rule-1', id('rg-app')));
  });

  it('still tells different resources apart', () => {
    expect(computeFingerprint('rule-1', id('rg-app'))).not.toBe(computeFingerprint('rule-1', id('rg-other')));
  });

  it('keeps the resource id casing on the finding itself', () => {
    const finding = createFinding({
      module: 'security', ruleId: 'rule-1', severity: 'high', category: 'security',
      resourceId: id('RG-APP'), resourceType: 'microsoft.compute/virtualmachines', resourceName: 'vm-1',
      subscriptionId: 'sub-1', title: 't', description: 'd', evidence: {}, recommendation: 'r',
    });
    expect(finding.resourceId).toBe(id('RG-APP'));
    expect(finding.fingerprint).toBe(computeFingerprint('rule-1', id('rg-app')));
  });
});

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
    // resourceId would be: the 'activity' namespace segment must still keep these apart.
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
  it('never sets kind: absence is the "state" default', () => {
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

describe('classifyArmPlacement()', () => {
  it('is a resource when it has a subscription and a resource group', () => {
    expect(classifyArmPlacement({ subscriptionId: 'sub-1', resourceGroup: 'rg-1', resourceId: '/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Compute/virtualMachines/vm' }))
      .toEqual({ placement: 'resource' });
  });

  it('is a subscription finding when it has a subscription and no resource group', () => {
    expect(classifyArmPlacement({ subscriptionId: 'sub-1', resourceId: '/subscriptions/sub-1' })).toEqual({ placement: 'subscription' });
    expect(classifyArmPlacement({ subscriptionId: 'sub-1', resourceGroup: '', resourceId: '/subscriptions/sub-1' })).toEqual({ placement: 'subscription' });
  });

  it('is a management group finding, naming the group, when there is no subscription and the id sits under one', () => {
    expect(classifyArmPlacement({ subscriptionId: '', resourceId: '/providers/Microsoft.Management/managementGroups/mg-platform' }))
      .toEqual({ placement: 'management-group', managementGroupId: 'mg-platform' });
    expect(classifyArmPlacement({ resourceId: '/providers/microsoft.management/managementgroups/MG-Root/providers/Microsoft.Authorization/policyAssignments/pa' }))
      .toEqual({ placement: 'management-group', managementGroupId: 'MG-Root' });
  });

  it('is unplaceable when there is no subscription and the id is not under a management group', () => {
    expect(classifyArmPlacement({ subscriptionId: '', resourceId: '/providers/Microsoft.Foo/things/t1' })).toEqual({ placement: 'unplaceable' });
    expect(classifyArmPlacement({ subscriptionId: '', resourceId: '/tenants/t1' })).toEqual({ placement: 'unplaceable' });
    expect(classifyArmPlacement({})).toEqual({ placement: 'unplaceable' });
  });

  it('does not take a management group id from the middle of an id', () => {
    expect(classifyArmPlacement({ resourceId: '/foo/providers/Microsoft.Management/managementGroups/mg-1' })).toEqual({ placement: 'unplaceable' });
  });
});

describe('createFinding() placement', () => {
  const input = {
    module: 'security', ruleId: 'rule-1', severity: 'high' as const, category: 'security',
    resourceType: 'x', resourceName: 'n', title: 't', description: 'd', evidence: {}, recommendation: 'r',
  };

  it('works the placement out from the subscription, resource group and id when none is given', () => {
    const f = createFinding({ ...input, resourceId: '/providers/Microsoft.Management/managementGroups/mg-1', subscriptionId: '' });
    expect(f.placement).toBe('management-group');
    expect(f.managementGroupId).toBe('mg-1');
  });

  it('keeps a placement the engine states, and no management group for it', () => {
    const f = createFinding({ ...input, resourceId: 'users/u1', subscriptionId: '', placement: 'directory' });
    expect(f.placement).toBe('directory');
    expect(f.subscriptionId).toBe('');
    expect(f.managementGroupId).toBeUndefined();
  });
});
