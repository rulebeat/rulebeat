/**
 * Every subscription RuleBeat knows about, as one list for the Subscription scorecard, and for the
 * trend-point writer to use when it writes a point per subscription: the stored management group tree's
 * subscription nodes, the subscriptions an enabled rule's scope names, and the subscriptions that hold an
 * active finding. Pure, no DB or Node imports.
 *
 * Deduped without regard to case. A subscription the tree knows is shown with the tree's name and case;
 * otherwise with the casing that named it first and no name.
 */
import { DIRECTORY_SUBSCRIPTION } from './placement';
import type { HierarchyNode } from './management-group-tree';
import type { Rule } from './types';

export interface KnownSubscription {
  /** The id in lower case: how a level is keyed and compared. */
  key: string;
  /** The id as shown: the tree's casing when the tree knows it. */
  id: string;
  /** The tree's display name, else null. */
  name: string | null;
}

export interface KnownSubscriptionSources {
  hierarchy: readonly Pick<HierarchyNode, 'kind' | 'id' | 'name'>[];
  rules: readonly Pick<Rule, 'enabled' | 'scope'>[];
  /** The subscription id of each active finding that sits under one. */
  findingSubscriptions: Iterable<string>;
}

export function knownSubscriptions({ hierarchy, rules, findingSubscriptions }: KnownSubscriptionSources): KnownSubscription[] {
  const known = new Map<string, KnownSubscription>();
  const add = (id: string, name: string | null): void => {
    const trimmed = id.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || key === DIRECTORY_SUBSCRIPTION) return;
    const existing = known.get(key);
    if (!existing) known.set(key, { key, id: trimmed, name });
    else if (name !== null && existing.name === null) known.set(key, { key, id: trimmed, name });
  };

  for (const node of hierarchy) if (node.kind === 'subscription') add(node.id, node.name);
  for (const rule of rules) if (rule.enabled) for (const id of rule.scope?.subscriptions ?? []) add(id, null);
  for (const id of findingSubscriptions) add(id, null);
  return [...known.values()];
}
