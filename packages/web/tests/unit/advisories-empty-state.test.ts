import { describe, expect, it } from 'vitest';
import { advisoriesEmptyState } from '@/lib/advisories-empty-state';

type R = Parameters<typeof advisoriesEmptyState>[0][number];
const rule = (over: Partial<R>): R => ({ kind: 'advisory', enabled: true, ...over });

describe('advisoriesEmptyState', () => {
  it('says no Advisory rule is enabled when there are no rules of the kind at all', () => {
    const s = advisoriesEmptyState([rule({ kind: 'state' }), rule({ kind: 'activity' })]);
    expect(s.reason).toBe('none-enabled');
    expect(s.title).toMatch(/no advisory rules/i);
  });

  it('says no Advisory rule is enabled when the only Advisory rule is disabled', () => {
    const s = advisoriesEmptyState([rule({ enabled: false, lastRunStatus: 'success', lastRunAt: '2025-01-01T00:00:00Z' })]);
    expect(s.reason).toBe('none-enabled');
  });

  it('says the rules have not run yet when no enabled Advisory rule has a run on record', () => {
    const s = advisoriesEmptyState([rule({}), rule({})]);
    expect(s.reason).toBe('not-run');
    expect(s.hint).toMatch(/scan/i);
  });

  it('says nothing was found when every Advisory rule that ran succeeded', () => {
    const s = advisoriesEmptyState([
      rule({ lastRunStatus: 'success', lastRunAt: '2025-01-01T00:00:00Z' }),
      rule({}),
    ]);
    expect(s.reason).toBe('clear');
    expect(s.title).toMatch(/no open advisories/i);
  });

  it('does not claim a clean result when a rule that ran did not complete', () => {
    for (const status of ['failed', 'capped', 'invalid'] as const) {
      const s = advisoriesEmptyState([
        rule({ lastRunStatus: 'success', lastRunAt: '2025-01-01T00:00:00Z' }),
        rule({ lastRunStatus: status, lastRunAt: '2025-01-01T00:00:00Z' }),
      ]);
      expect(s.reason).toBe('incomplete');
      expect(s.title).not.toMatch(/no open advisories/i);
    }
  });

  it('never uses an em dash', () => {
    const rulesets: R[][] = [
      [], [rule({})],
      [rule({ lastRunStatus: 'success', lastRunAt: 'x' })],
      [rule({ lastRunStatus: 'failed', lastRunAt: 'x' })],
    ];
    for (const rs of rulesets) {
      const s = advisoriesEmptyState(rs);
      expect(`${s.title} ${s.hint}`).not.toContain('\u2014');
    }
  });
});
