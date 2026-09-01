/**
 * Spec 029 — queryBackend/shape/kind round-trip through lib/rules.ts (ruleToRow/rowToRule).
 * `kind` is never trusted from the input Rule: ruleToRow() always recomputes it from queryBackend
 * via deriveKind(), so a stale or forged kind on the wire (e.g. a hand-crafted API payload) can
 * never persist. See deriveKind()'s own comment in lib/rules.ts and the RuleKind field comment in
 * packages/core/src/engine/types.ts.
 *
 * Spec 031 — `shape` follows the same discipline: ruleToRow() recomputes it from appliesTo via
 * deriveShape(), so a stale or forged shape on the wire can never persist either. See
 * deriveShape()'s own comment in lib/rules.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { QueryBackend, Rule, RuleKind, VisualQuery } from '@rulebeat/core';
import { deriveKind, deriveShape, loadRules, saveRules } from '@/lib/rules';
import { clearRules } from '../helpers/db';

const RULE_ID = 'taxonomy-roundtrip-test';

function baseRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: RULE_ID,
    name: 'taxonomy roundtrip test',
    description: 'test',
    category: 'security',
    severity: 'medium',
    enabled: true,
    type: 'custom',
    scope: { level: 'subscription' },
    resourceTypes: [],
    conditions: [],
    rawKql: 'resources | where type == "microsoft.compute/virtualmachines"',
    ...overrides,
  };
}

// Minimal but real stage-based VisualQuery (spec 031's appliesTo shape) — a single filter stage
// with one condition, matching the fixture already used in core's runner-outcomes.test.ts.
const appliesTo: VisualQuery = {
  stages: [{
    id: 'f1',
    type: 'filter',
    groups: [{ id: 'g1', conditions: [{ id: 'c1', field: 'name', operator: 'exists' }] }],
  }],
};

describe('deriveKind() (spec 029)', () => {
  it('derives state for resource-graph and microsoft-graph, activity only for log-analytics', async () => {
    const cases: Array<[QueryBackend, RuleKind]> = [
      ['resource-graph', 'state'],
      ['microsoft-graph', 'state'],
      ['log-analytics', 'activity'],
    ];
    for (const [backend, expected] of cases) {
      expect(deriveKind(backend)).toBe(expected);
    }
  });
});

describe('deriveShape() (spec 031)', () => {
  it('derives detect when appliesTo is absent, assert when present', async () => {
    expect(deriveShape(undefined)).toBe('detect');
    expect(deriveShape(appliesTo)).toBe('assert');
  });
});

describe('spec 029 · queryBackend/shape/kind round-trip through lib/rules.ts', () => {
  beforeEach(async () => {
    await clearRules();
  });

  it.each([
    ['resource-graph', 'state'],
    ['microsoft-graph', 'state'],
    ['log-analytics', 'activity'],
  ] as const)('a %s rule reloads with kind %s', async (queryBackend, expectedKind) => {
    await saveRules([baseRule({ queryBackend })]);
    const reloaded = (await loadRules()).find(r => r.id === RULE_ID);
    expect(reloaded).toBeDefined();
    expect(reloaded!.queryBackend).toBe(queryBackend);
    expect(reloaded!.kind).toBe(expectedKind);
  });

  it('defaults queryBackend to resource-graph and shape to detect when both are omitted', async () => {
    await saveRules([baseRule()]);
    const reloaded = (await loadRules()).find(r => r.id === RULE_ID);
    expect(reloaded!.queryBackend).toBe('resource-graph');
    expect(reloaded!.shape).toBe('detect');
    expect(reloaded!.kind).toBe('state');
  });

  it('recomputes kind from queryBackend even when the input Rule carries a stale/forged kind', async () => {
    const forged = baseRule({ queryBackend: 'log-analytics', kind: 'state' });
    await saveRules([forged]);
    const reloaded = (await loadRules()).find(r => r.id === RULE_ID);
    expect(reloaded!.kind).toBe('activity');
  });
});

describe('spec 031 · appliesTo/shape round-trip through lib/rules.ts', () => {
  beforeEach(async () => {
    await clearRules();
  });

  it('a rule with no appliesTo reloads with shape detect and no appliesTo', async () => {
    await saveRules([baseRule()]);
    const reloaded = (await loadRules()).find(r => r.id === RULE_ID);
    expect(reloaded!.appliesTo).toBeUndefined();
    expect(reloaded!.shape).toBe('detect');
  });

  it('a rule with appliesTo reloads with shape assert and the population query intact', async () => {
    await saveRules([baseRule({ appliesTo })]);
    const reloaded = (await loadRules()).find(r => r.id === RULE_ID);
    expect(reloaded!.shape).toBe('assert');
    expect(reloaded!.appliesTo).toEqual(appliesTo);
  });

  it('recomputes shape from appliesTo even when the input Rule carries a stale/forged shape', async () => {
    const forged = baseRule({ appliesTo, shape: 'detect' });
    await saveRules([forged]);
    const reloaded = (await loadRules()).find(r => r.id === RULE_ID);
    expect(reloaded!.shape).toBe('assert');
  });

  it('recomputes shape to detect when appliesTo is absent, even when the input Rule forges shape assert', async () => {
    const forged = baseRule({ shape: 'assert' });
    await saveRules([forged]);
    const reloaded = (await loadRules()).find(r => r.id === RULE_ID);
    expect(reloaded!.shape).toBe('detect');
  });
});
