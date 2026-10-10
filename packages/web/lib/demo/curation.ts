import type { Rule } from '@rulebeat/core';
import { buildAprlFixtures } from './aprl-fixtures';
import { CORE_FIXTURES, unfixturedCoreRuleIds } from './core-fixtures';
import type { RuleFixture } from './rule-fixture';

/**
 * Rules the Demo has a fixture for but ships switched off. Every other rule that starts switched off
 * has no data behind it and fails when run, so these are the only ones a Visitor can switch on and
 * watch go from "not yet proven" to passing or failing (docs/public/posture.md).
 *
 * Named by id, not picked by position or by a hash over the pack, so a release can never move the
 * choice to a different rule unseen. If an update drops one of these, changes its resource types or
 * gives another rule its query, `curateRules()` refuses to generate: a held-back rule that quietly
 * became unanswerable would bring back the switched-off rule that cannot be proven, with nothing red.
 *
 * "Missing Environment Tag" is a RuleBeat Core rule with a hand-authored fixture and a query no other
 * rule shares, and it ships switched off in a real install. Under the default Seed it finds nothing,
 * so it passes on its first scan and the posture ring recovers.
 */
export const HELD_BACK_RULE_IDS: readonly string[] = [
  'db175338-5c33-484a-bcf5-24f20e3bc60c',
];

export interface RuleCuration {
  /** A fixture for every rule the Demo can answer, switched on or held back. */
  fixtures: RuleFixture[];
  enabledIds: string[];
  /** Every rule to switch off: the held-back ones, the APRL rules the estate has nothing for, and
   *  the core rules the Demo has no fixture for. */
  disabledIds: string[];
  heldBackIds: string[];
}

/** Which of the shipped rules a freshly generated Demo has switched on, and which off. Decided by
 *  membership alone, so the order `allRules` arrives in cannot change the result. Never trusts the
 *  enabled-by-default subset the packs shipped, which was not chosen with this estate in mind. */
export function curateRules(allRules: Rule[], heldBack: readonly string[] = HELD_BACK_RULE_IDS): RuleCuration {
  const aprlFixtures = buildAprlFixtures(allRules);
  const fixtures = [...CORE_FIXTURES, ...aprlFixtures];
  const answerable = new Set(fixtures.map(f => f.ruleId));
  const aprlAnswerable = new Set(aprlFixtures.map(f => f.ruleId));

  // fake-context.ts finds a rule's fixture by the rule's query text, so a held-back rule whose query
  // another fixture-backed rule shares is answered by whichever of the two the context indexes last.
  const queryOwners = new Map<string, number>();
  for (const rule of allRules) {
    if (rule.rawKql && answerable.has(rule.id)) queryOwners.set(rule.rawKql.trim(), (queryOwners.get(rule.rawKql.trim()) ?? 0) + 1);
  }
  const unprovable = heldBack.filter(id => {
    const rule = allRules.find(r => r.id === id);
    return !rule || !answerable.has(id) || !rule.rawKql || queryOwners.get(rule.rawKql.trim()) !== 1;
  });
  if (unprovable.length > 0) {
    throw new Error(
      `Demo generator: rule(s) ${unprovable.join(', ')} are held back switched off so a Visitor can prove them, `
      + `but this release no longer ships them, has no fixture for them, or gives their query to another rule. `
      + `Hold back another rule.`,
    );
  }

  const held = new Set(heldBack);
  return {
    fixtures,
    enabledIds: fixtures.map(f => f.ruleId).filter(id => !held.has(id)),
    disabledIds: [
      ...heldBack,
      ...allRules.filter(r => r.pack === 'aprl-v2' && !aprlAnswerable.has(r.id)).map(r => r.id),
      ...unfixturedCoreRuleIds(allRules),
    ],
    heldBackIds: [...heldBack],
  };
}
