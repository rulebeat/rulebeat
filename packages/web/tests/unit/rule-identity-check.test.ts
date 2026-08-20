/**
 * Spec 005 — shared identity contract between validate-kql and the rule-save routes.
 * `checkRowsHaveIdentity` is the pure predicate; `probeRuleIdentitySample` wraps it with the
 * save-time fail-open behavior (only a *confirmed bad result* blocks a save — any other failure,
 * e.g. Azure unreachable or no credential yet, must let the save through).
 */
import { describe, expect, it } from 'vitest';
import { checkRowsHaveIdentity, probeRuleIdentitySample } from '@/lib/rule-identity-check';
import { fakeTenantContext, argRow } from '../helpers/fake-azure';

describe('checkRowsHaveIdentity()', () => {
  it('is valid when every row has a non-empty string id', () => {
    const result = checkRowsHaveIdentity([argRow({ name: 'vm-1' }), argRow({ name: 'vm-2' })]);
    expect(result).toEqual({ valid: true, invalidCount: 0 });
  });

  it('counts a missing id property as invalid', () => {
    const result = checkRowsHaveIdentity([{ name: 'no-id-at-all' }]);
    expect(result).toEqual({ valid: false, invalidCount: 1 });
  });

  it('counts null, empty-string, and whitespace-only id as invalid, not just an absent property', () => {
    const result = checkRowsHaveIdentity([
      { id: null, name: 'a' },
      { id: '', name: 'b' },
      { id: '   ', name: 'c' },
      argRow({ name: 'd' }),
    ]);
    expect(result).toEqual({ valid: false, invalidCount: 3 });
  });

  it('is valid (vacuously) for an empty row set', () => {
    expect(checkRowsHaveIdentity([])).toEqual({ valid: true, invalidCount: 0 });
  });
});

describe('probeRuleIdentitySample()', () => {
  it('blocks when the sampled rows confirm a missing resource id', async () => {
    const ctx = fakeTenantContext({ rows: [{ name: 'no-id' }] });
    const result = await probeRuleIdentitySample('resources | summarize count() by type', ctx);
    expect(result).toEqual({ blocked: true, invalidCount: 1, sampleSize: 1 });
  });

  it('does not block when the sampled rows all carry an id', async () => {
    const ctx = fakeTenantContext({ rows: [argRow()] });
    const result = await probeRuleIdentitySample('resources | where type == "microsoft.compute/virtualmachines"', ctx);
    expect(result).toEqual({ blocked: false });
  });

  it('fails open when the probe query itself throws — a transient Azure error must not block saving', async () => {
    const ctx = fakeTenantContext({ failWith: new Error('429 Too Many Requests') });
    const result = await probeRuleIdentitySample('resources | where type == "microsoft.compute/virtualmachines"', ctx);
    expect(result).toEqual({ blocked: false });
  });

  it('appends a row cap only when the query has none already', async () => {
    const ctx = fakeTenantContext({ rows: [argRow()] });
    await probeRuleIdentitySample('resources | where type == "microsoft.compute/virtualmachines"', ctx);
    await probeRuleIdentitySample('resources | where type == "microsoft.compute/virtualmachines" | take 20', ctx);

    expect(ctx.queries[0]!.kql).toMatch(/\|\s*take\s+5\s*$/);
    expect(ctx.queries[1]!.kql).not.toMatch(/take 5/);
    expect(ctx.queries[1]!.kql).toMatch(/take 20/);
  });
});
