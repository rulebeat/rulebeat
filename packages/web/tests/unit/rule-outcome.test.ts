/**
 * A rule's Outcome at a Scope (#402), by formula v3's definition of passing. Failing is an open finding
 * inside the Scope; passing is none, and the newest finished scan covering the Scope ran the rule without
 * listing it as incomplete. Anything else is unknown, an Activity rule is only checked or unknown, and a
 * disabled rule has no Outcome at all.
 */
import { describe, expect, it } from 'vitest';
import { EVERYTHING_COVERED } from '@/lib/run-scope';
import { outcomeMatches, ruleOutcome, type OutcomeRule, type OutcomeScan } from '@/lib/rule-outcome';

const RULE: OutcomeRule = { id: 'rule-1', enabled: true, kind: 'state', lastRunAt: '2026-06-02T00:00:00.000Z' };

function scanOf(over: Partial<OutcomeScan> = {}): OutcomeScan {
  return {
    finishedAt: '2026-06-02T00:00:00.000Z', subscriptionsScanned: [], coveredScope: EVERYTHING_COVERED,
    incompleteRuleIds: [], ranRuleIds: ['rule-1'], ...over,
  };
}

describe('ruleOutcome', () => {
  it('is passing with no open finding and a covering scan that ran the rule', () => {
    expect(ruleOutcome(RULE, { hasOpenFinding: false, scans: [scanOf()] })).toBe('passing');
  });

  it('is failing with an open finding', () => {
    expect(ruleOutcome(RULE, { hasOpenFinding: true, scans: [scanOf()] })).toBe('failing');
  });

  it('is failing with an open finding even when the last run was capped or failed, or no scan covers the Scope', () => {
    const capped = scanOf({ incompleteRuleIds: ['rule-1'] });
    expect(ruleOutcome(RULE, { hasOpenFinding: true, scans: [capped] })).toBe('failing');
    expect(ruleOutcome(RULE, { hasOpenFinding: true, scans: [undefined] })).toBe('failing');
  });

  it('is unknown when the covering scan listed the rule as incomplete', () => {
    expect(ruleOutcome(RULE, { hasOpenFinding: false, scans: [scanOf({ incompleteRuleIds: ['rule-1'] })] })).toBe('unknown');
  });

  it('is unknown when no scan covers the Scope', () => {
    expect(ruleOutcome(RULE, { hasOpenFinding: false, scans: [undefined] })).toBe('unknown');
    expect(ruleOutcome(RULE, { hasOpenFinding: false, scans: [] })).toBe('unknown');
  });

  it('is unknown when the covering scan did not run the rule (it came before the rule existed or was enabled)', () => {
    expect(ruleOutcome(RULE, { hasOpenFinding: false, scans: [scanOf({ ranRuleIds: ['another-rule'] })] })).toBe('unknown');
  });

  it('reads a scan that recorded no rule list by the rule\'s own last run: ran only if the rule ran at or after it', () => {
    const recorded = scanOf({ ranRuleIds: null, finishedAt: '2026-06-02T00:00:00.000Z' });
    expect(ruleOutcome(RULE, { hasOpenFinding: false, scans: [recorded] })).toBe('passing');
    expect(ruleOutcome({ ...RULE, lastRunAt: '2026-06-01T00:00:00.000Z' }, { hasOpenFinding: false, scans: [recorded] })).toBe('unknown');
    expect(ruleOutcome({ ...RULE, lastRunAt: undefined }, { hasOpenFinding: false, scans: [recorded] })).toBe('unknown');
  });

  it('needs every Scope covered to be passing, and one failing Scope is failing', () => {
    expect(ruleOutcome(RULE, { hasOpenFinding: false, scans: [scanOf(), scanOf()] })).toBe('passing');
    expect(ruleOutcome(RULE, { hasOpenFinding: false, scans: [scanOf(), undefined] })).toBe('unknown');
    expect(ruleOutcome(RULE, { hasOpenFinding: true, scans: [scanOf(), undefined] })).toBe('failing');
  });

  it('has no Outcome for a disabled rule, whatever its findings and scans say', () => {
    expect(ruleOutcome({ ...RULE, enabled: false }, { hasOpenFinding: true, scans: [scanOf()] })).toBeNull();
    expect(ruleOutcome({ ...RULE, enabled: false }, { hasOpenFinding: false, scans: [scanOf()] })).toBeNull();
  });

  it('never reads an Activity rule as passing or failing: checked after a clean run, otherwise unknown', () => {
    const activity: OutcomeRule = { ...RULE, kind: 'activity' };
    expect(ruleOutcome(activity, { hasOpenFinding: false, scans: [scanOf()] })).toBe('checked');
    expect(ruleOutcome(activity, { hasOpenFinding: true, scans: [scanOf()] })).toBe('checked');
    expect(ruleOutcome(activity, { hasOpenFinding: false, scans: [scanOf({ incompleteRuleIds: ['rule-1'] })] })).toBe('unknown');
    expect(ruleOutcome(activity, { hasOpenFinding: false, scans: [undefined] })).toBe('unknown');
  });

  it('treats an Advisory rule like a Problem rule', () => {
    const advisory: OutcomeRule = { ...RULE, kind: 'advisory' };
    expect(ruleOutcome(advisory, { hasOpenFinding: true, scans: [scanOf()] })).toBe('failing');
    expect(ruleOutcome(advisory, { hasOpenFinding: false, scans: [scanOf()] })).toBe('passing');
  });
});

describe('outcomeMatches', () => {
  it('matches each Outcome to itself', () => {
    for (const outcome of ['passing', 'failing', 'unknown', 'checked'] as const) {
      expect(outcomeMatches(outcome, outcome)).toBe(true);
    }
    expect(outcomeMatches('passing', 'failing')).toBe(false);
  });

  it('reads checked as passing or failing, and an Activity rule that was checked', () => {
    expect(outcomeMatches('passing', 'checked')).toBe(true);
    expect(outcomeMatches('failing', 'checked')).toBe(true);
    expect(outcomeMatches('checked', 'checked')).toBe(true);
    expect(outcomeMatches('unknown', 'checked')).toBe(false);
  });

  it('never matches a rule with no Outcome', () => {
    for (const wanted of ['passing', 'failing', 'unknown', 'checked'] as const) expect(outcomeMatches(null, wanted)).toBe(false);
  });
});
