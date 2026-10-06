import { describe, expect, it } from 'vitest';
import { isExternalPack } from '@/app/(app)/library/pack-manifest';

describe('isExternalPack', () => {
  const external = {
    label: 'APRL', source: 'https://example.test/aprl', license: 'MIT', attribution: 'Someone',
    pinnedCommit: 'abcdef1234567', syncedAt: '2026-06-08', policyCount: 143,
  };

  it('accepts an entry that carries everything the pack banner shows', () => {
    expect(isExternalPack(external)).toBe(true);
  });

  it('rejects RuleBeat Core, whose entry names only a label and a version scheme', () => {
    expect(isExternalPack({ label: 'RuleBeat Core' })).toBe(false);
  });

  it('rejects an unknown pack and an entry missing any one field', () => {
    expect(isExternalPack(undefined)).toBe(false);
    for (const key of ['source', 'license', 'attribution', 'pinnedCommit', 'syncedAt', 'policyCount'] as const) {
      const { [key]: _omitted, ...rest } = external;
      expect(isExternalPack(rest), `without ${key}`).toBe(false);
    }
  });

  it('accepts a pack with no rules yet, since a count of zero is still a count', () => {
    expect(isExternalPack({ ...external, policyCount: 0 })).toBe(true);
  });
});
