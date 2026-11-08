/**
 * The limits module is the one place a widget's limit wording lives. These pin the sentences the
 * dashboard docs (docs/public/posture.md) promise, as literals, so a reworded note is a deliberate
 * edit of both.
 */
import { describe, expect, it } from 'vitest';
import {
  EVERYONE_LINE, NO_ACCESS_HEADING, RULE_FORM_SAVE_NOTE, RULE_FORM_SEVERITY_HELP,
  WIDGET_LIMITS, activityRetentionNote, categoryEmptyLabel, postureEmptyReason, postureLimitNote,
  ruleSelectionNote, severityMeasure, trendRetentionNote,
} from '@/lib/widget-limits';

describe('the posture limit note', () => {
  it('is the everyone line for someone who holds Everything', () => {
    expect(EVERYONE_LINE).toBe(
      'A rule passes when it has no open finding and its most recent run succeeded. An edit to a rule counts from its next run.',
    );
    expect(postureLimitNote(true)).toBe(EVERYONE_LINE);
  });

  it('swaps W1 in for the first sentence for anyone else and keeps the second', () => {
    expect(WIDGET_LIMITS.w1).toBe(
      'A rule passes here when it has no open finding in your Access and its most recent run succeeded. That run may have covered a different part of the estate.',
    );
    expect(postureLimitNote(false)).toBe(`${WIDGET_LIMITS.w1} An edit to a rule counts from its next run.`);
  });
});

describe('the reasons a posture has nothing to count', () => {
  it('opens with the no-access heading the full-page state also reads', () => {
    expect(NO_ACCESS_HEADING).toBe('You have been given no access');
    expect(postureEmptyReason('no-access').title).toBe(NO_ACCESS_HEADING);
  });

  it('names each of the other reasons in words, none of them a bare "No data"', () => {
    expect(postureEmptyReason('no-rules-here').title).toBe('No rules here look at anything you hold');
    expect(postureEmptyReason('no-enabled-rules').title).toBe('No enabled rules');
    expect(postureEmptyReason('filter-left-nothing').title).toBe('The filter left nothing to count');
    for (const key of ['no-access', 'no-rules-here', 'no-enabled-rules', 'filter-left-nothing'] as const) {
      expect(postureEmptyReason(key).detail.length).toBeGreaterThan(20);
    }
  });

  it('gives a Category scorecard tile its short label by whether the viewer holds Everything', () => {
    expect(categoryEmptyLabel(true)).toBe('No enabled rules');
    expect(categoryEmptyLabel(false)).toBe('No rules here look at anything you hold');
  });
});

describe('the measure under a Severity filter', () => {
  it('lists the picked severities, most severe first', () => {
    expect(severityMeasure(['critical'])).toBe('Rules with no Critical finding');
    expect(severityMeasure(['high', 'critical'])).toBe('Rules with no Critical or High finding');
    expect(severityMeasure(['low', 'critical', 'high'])).toBe('Rules with no Critical, High or Low finding');
  });

  it('is nothing without a Severity filter', () => {
    expect(severityMeasure(undefined)).toBeNull();
    expect(severityMeasure([])).toBeNull();
  });
});

describe('the note on a rule-scoped widget', () => {
  it('counts the selected rules that are not counted', () => {
    expect(ruleSelectionNote(5, 2)).toBe(
      '2 selected rules are not counted because they are disabled, no longer exist, or look at nothing you hold',
    );
    expect(ruleSelectionNote(5, 1)).toBe(
      '1 selected rule is not counted because it is disabled, no longer exists, or looks at nothing you hold',
    );
  });

  it('says none is counted when every selected rule is left out', () => {
    expect(ruleSelectionNote(3, 3)).toBe('None of the selected rules is counted');
    expect(ruleSelectionNote(1, 1)).toBe('None of the selected rules is counted');
  });

  it('is nothing when every selected rule is counted, or none was selected', () => {
    expect(ruleSelectionNote(3, 0)).toBeNull();
    expect(ruleSelectionNote(0, 0)).toBeNull();
  });
});

describe('the other wording the module holds', () => {
  it('keeps W2 to W4 as the spec words them', () => {
    expect(Object.keys(WIDGET_LIMITS)).toEqual(['w1', 'w2', 'w3', 'w4', 'w5']);
    expect(WIDGET_LIMITS.w2).toBe(
      "A rule counts for every subscription or resource group its scope includes, even one with none of the resources it checks. A rule whose query picks subscriptions itself counts for all of them. Passing uses the rule's most recent run anywhere. A finding placed at a management group is counted in the footer, not against the subscriptions under it.",
    );
    expect(WIDGET_LIMITS.w3).toBe(
      'A rule scoped to a management group counts for its subscriptions once RuleBeat has read the management group tree.',
    );
    expect(WIDGET_LIMITS.w4).toBe(
      'A trend is not drawn with any filter other than category, the date window, or a single subscription or the Directory. Trend points are kept per category for the whole install, each subscription and the Directory.',
    );
  });

  it('words W5 as the marker note, naming the date the counting changed', () => {
    expect(WIDGET_LIMITS.w5('2026-03-04')).toBe(
      'Counted differently before 2026-03-04. Earlier points use an older definition: see docs/public/posture.md.',
    );
  });

  it('says in each retention note where the chart starts', () => {
    expect(trendRetentionNote('2025-11-09')).toBe('Trend points are kept for 365 days, so this chart starts on 2025-11-09.');
    expect(activityRetentionNote('2026-05-12')).toBe('Activity occurrences are kept for 180 days, so this chart starts on 2026-05-12.');
  });

  it('keeps the two rule form lines', () => {
    expect(RULE_FORM_SEVERITY_HELP).toBe('A change to the severity reaches open findings on the next scan.');
    expect(RULE_FORM_SAVE_NOTE).toBe("Posture keeps this rule's last result until it next runs.");
  });
});
