/**
 * Spec 029 — queryBackend/kind round-trip through lib/rules.ts (ruleToRow/rowToRule).
 * `kind` is never trusted from the input Rule: ruleToRow() always recomputes it from queryBackend
 * via deriveKind(), so a stale or forged kind on the wire (e.g. a hand-crafted API payload) can
 * never persist. See deriveKind()'s own comment in lib/rules.ts and the RuleKind field comment in
 * packages/core/src/engine/types.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { QueryBackend, Rule, RuleKind } from '@rulebeat/core';
import { deriveKind, loadRules, saveRules } from '@/lib/rules';
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

describe('spec 029 · queryBackend/kind round-trip through lib/rules.ts', () => {
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

  it('defaults queryBackend to resource-graph when it is omitted', async () => {
    await saveRules([baseRule()]);
    const reloaded = (await loadRules()).find(r => r.id === RULE_ID);
    expect(reloaded!.queryBackend).toBe('resource-graph');
    expect(reloaded!.kind).toBe('state');
  });

  it('recomputes kind from queryBackend even when the input Rule carries a stale/forged kind', async () => {
    const forged = baseRule({ queryBackend: 'log-analytics', kind: 'state' });
    await saveRules([forged]);
    const reloaded = (await loadRules()).find(r => r.id === RULE_ID);
    expect(reloaded!.kind).toBe('activity');
  });
});
