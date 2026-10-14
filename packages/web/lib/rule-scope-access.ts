/**
 * What a person is shown of a rule's scope (#275). A rule's scope names subscriptions and management
 * groups, which are the tenant's own ids; a person who does not hold them is not told them. Everything
 * else on the rule (name, description, KQL, conditions and the three query definitions) is the same for
 * every person, so this is the one function every route and page that sends a rule to a browser runs.
 * Pure, no DB or Node imports. The scheduler and the engine read the rules unnarrowed.
 */
import type { Access } from './access-model';
import { heldScopes, holdsManagementGroup, holdsSubscription } from './held-scopes';
import type { RuleScope } from './types';

/**
 * The rule with the scope entries the person does not hold dropped and `scope.outsideAccess` set to how
 * many there were. A person on Everything gets the rule itself, untouched. The count is left off when
 * nothing was dropped.
 */
export function narrowRuleScope<R extends { scope: RuleScope }>(rule: R, access: Access): R {
  if (access.everything) return rule;
  const held = heldScopes(access);
  const subscriptions = (rule.scope.subscriptions ?? []).filter(id => holdsSubscription(held, id));
  const managementGroups = (rule.scope.managementGroups ?? []).filter(id => holdsManagementGroup(held, id));
  const dropped = (rule.scope.subscriptions?.length ?? 0) - subscriptions.length
    + (rule.scope.managementGroups?.length ?? 0) - managementGroups.length;

  const { subscriptions: _s, managementGroups: _m, outsideAccess: _o, ...rest } = rule.scope;
  const scope: RuleScope = {
    ...rest,
    ...(subscriptions.length ? { subscriptions } : {}),
    ...(managementGroups.length ? { managementGroups } : {}),
    ...(dropped > 0 ? { outsideAccess: dropped } : {}),
  };
  return { ...rule, scope };
}

export function narrowRulesScope<R extends { scope: RuleScope }>(rules: readonly R[], access: Access): R[] {
  return rules.map(rule => narrowRuleScope(rule, access));
}
