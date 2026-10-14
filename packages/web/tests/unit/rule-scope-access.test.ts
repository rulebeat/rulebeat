/**
 * #275: what a person is shown of a rule's scope. The function drops the subscription and management group
 * entries the person does not hold, counts them, and leaves every other part of the rule alone.
 */
import { describe, expect, it } from 'vitest';
import { buildAccess, everythingAccess, parseScope, type Access } from '@/lib/access-model';
import { narrowRuleScope, narrowRulesScope } from '@/lib/rule-scope-access';
import type { RuleScope } from '@/lib/types';

const SUB_A = '00000000-0000-0000-0000-00000000000a';
const SUB_B = '00000000-0000-0000-0000-00000000000b';
const MG = 'mg-example';

const rule = (scope: RuleScope) => ({
  id: 'r1', name: 'A rule', description: 'Checks things', rawKql: 'resources | project id',
  visualQuery: { stages: [] }, graphQuery: { path: 'users' }, logsQuery: { kql: 'SigninLogs' }, conditions: [{ field: 'x' }], scope,
});
const FULL: RuleScope = { level: 'subscription', subscriptions: [SUB_A, SUB_B], managementGroups: [MG] };

const holding = (...paths: string[]): Access =>
  buildAccess(paths.map(path => ({ tenantId: 't', scope: parseScope(path)!, role: 'viewer' as const })), 'manual');

describe('narrowRuleScope', () => {
  it('returns the rule itself, untouched, for a person on Everything', () => {
    const r = rule(FULL);
    expect(narrowRuleScope(r, everythingAccess('editor', 'manual'))).toBe(r);
    expect(narrowRuleScope(r, everythingAccess('admin'))).toBe(r);
  });

  it('keeps the subscription held and counts the other two entries', () => {
    expect(narrowRuleScope(rule(FULL), holding(`/subscriptions/${SUB_A}`)).scope).toEqual({
      level: 'subscription', subscriptions: [SUB_A], outsideAccess: 2,
    });
  });

  it('keeps the management group held and counts the two subscriptions', () => {
    expect(narrowRuleScope(rule(FULL), holding(`/providers/Microsoft.Management/managementGroups/${MG}`)).scope).toEqual({
      level: 'subscription', managementGroups: [MG], outsideAccess: 2,
    });
  });

  it('counts every entry for a person who holds none, and names none', () => {
    const scope = narrowRuleScope(rule(FULL), holding('@directory')).scope;
    expect(scope).toEqual({ level: 'subscription', outsideAccess: 3 });
    expect(JSON.stringify(scope)).not.toContain(SUB_A);
    expect(JSON.stringify(scope)).not.toContain(MG);
  });

  it('treats a resource group Scope as holding its subscription, and compares ids without regard to case', () => {
    expect(narrowRuleScope(rule(FULL), holding(`/subscriptions/${SUB_A.toUpperCase()}/resourceGroups/rg-one`)).scope.subscriptions).toEqual([SUB_A]);
  });

  it('adds no count when nothing is hidden, and does not invent one for a rule with no entries', () => {
    expect(narrowRuleScope(rule({ level: 'subscription', subscriptions: [SUB_A] }), holding(`/subscriptions/${SUB_A}`)).scope).toEqual({
      level: 'subscription', subscriptions: [SUB_A],
    });
    expect(narrowRuleScope(rule({ level: 'resource' }), holding()).scope).toEqual({ level: 'resource' });
  });

  it('leaves the name, description, KQL, conditions and the three query definitions as they are', () => {
    const r = rule(FULL);
    const { scope: _narrowed, ...rest } = narrowRuleScope(r, holding('@directory'));
    const { scope: _original, ...originalRest } = r;
    expect(rest).toEqual(originalRest);
  });

  it('does not change the rule it was given', () => {
    const r = rule(FULL);
    narrowRuleScope(r, holding('@directory'));
    expect(r.scope).toEqual(FULL);
  });

  it('replaces a count left on a rule that already carried one, rather than adding to it', () => {
    const narrowed = narrowRuleScope(rule({ ...FULL, outsideAccess: 9 }), holding(`/subscriptions/${SUB_A}`));
    expect(narrowed.scope.outsideAccess).toBe(2);
  });

  it('narrows a list, rule by rule', () => {
    const rules = narrowRulesScope([rule(FULL), rule({ level: 'resource' })], holding(`/subscriptions/${SUB_A}`));
    expect(rules.map(r => r.scope.outsideAccess)).toEqual([2, undefined]);
  });
});
