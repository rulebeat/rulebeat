/**
 * Issue #178: how the Advisories tab arranges findings. groupAdvisories() groups by rule, then by
 * group value, and orders what needs action first; the view param keeps the grouped/list choice in
 * the URL. Pure functions, exercised directly.
 */
import { describe, expect, it } from 'vitest';
import {
  groupAdvisories, parseAdvisoryView, advisoryViewParam, ADVISORY_VIEW_PARAM,
  type GroupableAdvisory,
} from '@/lib/advisory-groups';

function adv(overrides: Partial<GroupableAdvisory> & { resourceName: string }): GroupableAdvisory {
  return {
    ruleId: 'rule-a', policyName: 'Rule A', recommendation: 'Do the thing.', severity: 'medium',
    status: 'active', overdue: false,
    ...overrides,
  };
}

describe('groupAdvisories()', () => {
  it('groups by rule, then by group value', () => {
    const groups = groupAdvisories([
      adv({ resourceName: 'a1', groupValue: 'x' }),
      adv({ resourceName: 'b1', ruleId: 'rule-b', policyName: 'Rule B', groupValue: 'x' }),
      adv({ resourceName: 'a2', groupValue: 'y' }),
      adv({ resourceName: 'a3', groupValue: 'x' }),
    ]);
    expect(groups.map(r => r.ruleId).sort()).toEqual(['rule-a', 'rule-b']);
    const a = groups.find(r => r.ruleId === 'rule-a')!;
    expect(a.ruleName).toBe('Rule A');
    expect(a.hasNamedGroups).toBe(true);
    expect(a.groups.map(g => [g.groupValue, g.findings.map(f => f.resourceName).sort()])).toEqual(
      expect.arrayContaining([['x', ['a1', 'a3']], ['y', ['a2']]]),
    );
  });

  it('keeps a value distinct from the same value under another rule', () => {
    const groups = groupAdvisories([
      adv({ resourceName: 'a1', groupValue: 'x' }),
      adv({ resourceName: 'b1', ruleId: 'rule-b', policyName: 'Rule B', groupValue: 'x' }),
    ]);
    expect(groups.flatMap(r => r.groups.map(g => g.key))).toEqual(expect.arrayContaining(['rule-a::x', 'rule-b::x']));
  });

  it('makes a rule with no group value one group with no value', () => {
    const [rule] = groupAdvisories([adv({ resourceName: 'a1' }), adv({ resourceName: 'a2' })]);
    expect(rule.hasNamedGroups).toBe(false);
    expect(rule.groups).toHaveLength(1);
    expect(rule.groups[0].groupValue).toBeUndefined();
    expect(rule.groups[0].findings).toHaveLength(2);
  });

  it('puts findings without a value in their own group, last on a tie', () => {
    const [rule] = groupAdvisories([
      adv({ resourceName: 'none' }),
      adv({ resourceName: 'x1', groupValue: 'x' }),
    ]);
    expect(rule.hasNamedGroups).toBe(true);
    expect(rule.groups.map(g => g.groupValue)).toEqual(['x', undefined]);
  });

  it('shows the rule recommendation once per group, taken from the most urgent member', () => {
    const [rule] = groupAdvisories([
      adv({ resourceName: 'a1', groupValue: 'x', recommendation: 'later', deadline: '2030-01-01T00:00:00Z' }),
      adv({ resourceName: 'a2', groupValue: 'x', recommendation: 'sooner', deadline: '2026-01-01T00:00:00Z', overdue: true }),
    ]);
    expect(rule.groups).toHaveLength(1);
    expect(rule.groups[0].recommendation).toBe('sooner');
  });

  it('orders members Overdue first, then the earliest Deadline, then severity', () => {
    const [rule] = groupAdvisories([
      adv({ resourceName: 'no-deadline', severity: 'critical' }),
      adv({ resourceName: 'later', deadline: '2030-01-01T00:00:00Z' }),
      adv({ resourceName: 'sooner', deadline: '2029-01-01T00:00:00Z' }),
      adv({ resourceName: 'overdue', deadline: '2031-01-01T00:00:00Z', overdue: true }),
    ]);
    expect(rule.groups[0].findings.map(f => f.resourceName)).toEqual(['overdue', 'sooner', 'later', 'no-deadline']);
  });

  it('orders groups by their most urgent member, and rules by their most urgent group', () => {
    const groups = groupAdvisories([
      adv({ resourceName: 'calm', groupValue: 'calm', deadline: '2035-01-01T00:00:00Z' }),
      adv({ resourceName: 'hot', groupValue: 'hot', deadline: '2020-01-01T00:00:00Z', overdue: true }),
      adv({ resourceName: 'b1', ruleId: 'rule-b', policyName: 'Rule B', groupValue: 'q', deadline: '2026-01-01T00:00:00Z' }),
    ]);
    expect(groups.map(r => r.ruleId)).toEqual(['rule-a', 'rule-b']);
    expect(groups[0].groups.map(g => g.groupValue)).toEqual(['hot', 'calm']);
  });

  it('lets a fixed finding sit in its group without driving the group urgency', () => {
    const [rule] = groupAdvisories([
      adv({ resourceName: 'fixed', groupValue: 'a-fixed', status: 'fixed', deadline: '2020-01-01T00:00:00Z' }),
      adv({ resourceName: 'open', groupValue: 'b-open', deadline: '2030-01-01T00:00:00Z' }),
    ]);
    expect(rule.groups.map(g => g.groupValue)).toEqual(['b-open', 'a-fixed']);
    expect(rule.groups[1].openCount).toBe(0);
    expect(rule.groups[1].findings).toHaveLength(1);
  });

  it('puts a rule with nothing open after every rule that has something open', () => {
    const groups = groupAdvisories([
      adv({ resourceName: 'fixed', status: 'fixed', deadline: '2020-01-01T00:00:00Z' }),
      adv({ resourceName: 'open', ruleId: 'rule-b', policyName: 'Rule B', deadline: '2030-01-01T00:00:00Z' }),
    ]);
    expect(groups.map(r => r.ruleId)).toEqual(['rule-b', 'rule-a']);
  });

  it('counts open and overdue members per group and per rule', () => {
    const [rule] = groupAdvisories([
      adv({ resourceName: 'a1', groupValue: 'x', overdue: true }),
      adv({ resourceName: 'a2', groupValue: 'x' }),
      adv({ resourceName: 'a3', groupValue: 'y', status: 'fixed' }),
    ]);
    expect(rule.openCount).toBe(2);
    expect(rule.overdueCount).toBe(1);
    expect(rule.groups.find(g => g.groupValue === 'y')!.openCount).toBe(0);
  });

  it('is deterministic for ties and does not mutate or drop its input', () => {
    const input = [
      adv({ resourceName: 'z', groupValue: 'g' }),
      adv({ resourceName: 'a', groupValue: 'g' }),
      adv({ resourceName: 'm', groupValue: 'g' }),
    ];
    const copy = [...input];
    const first = groupAdvisories(input);
    expect(input).toEqual(copy);
    expect(first[0].groups[0].findings.map(f => f.resourceName)).toEqual(['a', 'm', 'z']);
    expect(groupAdvisories([...input].reverse())).toEqual(first);
  });

  it('returns nothing for no findings', () => {
    expect(groupAdvisories([])).toEqual([]);
  });
});

describe('the Advisories view param', () => {
  it('opens grouped unless the URL says list', () => {
    expect(parseAdvisoryView(undefined)).toBe('grouped');
    expect(parseAdvisoryView('grouped')).toBe('grouped');
    expect(parseAdvisoryView('nonsense')).toBe('grouped');
    expect(parseAdvisoryView('list')).toBe('list');
  });

  it('writes nothing for the default view and the view otherwise', () => {
    expect(advisoryViewParam('grouped')).toBeUndefined();
    expect(advisoryViewParam('list')).toBe('list');
    expect(ADVISORY_VIEW_PARAM).toBe('view');
  });

  it.each(['grouped', 'list'] as const)('round-trips %s through the URL', view => {
    const params = new URLSearchParams();
    const written = advisoryViewParam(view);
    if (written) params.set(ADVISORY_VIEW_PARAM, written);
    expect(parseAdvisoryView(params.get(ADVISORY_VIEW_PARAM) ?? undefined)).toBe(view);
  });
});
