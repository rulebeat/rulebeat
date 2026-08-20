/**
 * Spec 031 — De Morgan join-flip fix for buildRuleQuery()/buildConditionGroupExpr().
 *
 * Negating a condition group must also flip the join between its conditions, per De Morgan's law:
 * not (A and B) == not A or not B, never not A and not B. Before this fix, conditionToViolationKql
 * negated each condition individually but buildConditionGroupExpr still joined the negated parts
 * with the group's original join keyword — so a 2-condition AND group compiled to an AND of negated
 * conditions instead of an OR, silently matching far fewer resources than the rule actually meant.
 */
import { describe, expect, it } from 'vitest';
import { buildRuleQuery } from '../src/engine/kql.js';
import type { ConditionGroup, Rule } from '../src/engine/types.js';

function ruleWithGroup(group: ConditionGroup): Rule {
  return {
    id: 'test-rule',
    name: 'Test rule',
    description: 'desc',
    category: 'reliability',
    severity: 'medium',
    enabled: true,
    type: 'custom',
    scope: { level: 'resource' },
    resourceTypes: ['*'],
    conditions: [],
    conditionGroups: [group],
  };
}

describe('buildRuleQuery() De Morgan join-flip (spec 031)', () => {
  it('flips AND to OR when negating a 2-condition group', () => {
    const rule = ruleWithGroup({
      id: 'g1',
      conditions: [
        { id: 'c1', field: 'name', operator: 'equals', value: 'foo' },
        { id: 'c2', field: 'location', operator: 'equals', value: 'bar', join: 'and' },
      ],
    });

    // This is the case that fails without the fix: a plain (unflipped) join implementation would
    // emit 'and' here, which matches strictly fewer resources than the rule actually means.
    expect(buildRuleQuery(rule)).toBe(
      "Resources\n| where (name !~ 'foo' or location !~ 'bar')\n| project id, name, type, location, resourceGroup, subscriptionId, tags",
    );
  });

  it('flips OR to AND when negating a 2-condition group — the reverse case, so a fix that only special-cases AND cannot pass both', () => {
    const rule = ruleWithGroup({
      id: 'g1',
      conditions: [
        { id: 'c1', field: 'name', operator: 'equals', value: 'foo' },
        { id: 'c2', field: 'location', operator: 'equals', value: 'bar', join: 'or' },
      ],
    });

    expect(buildRuleQuery(rule)).toBe(
      "Resources\n| where (name !~ 'foo' and location !~ 'bar')\n| project id, name, type, location, resourceGroup, subscriptionId, tags",
    );
  });
});
