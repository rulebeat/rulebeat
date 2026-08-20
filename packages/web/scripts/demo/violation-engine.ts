import type { Severity } from '@rulebeat/core';
import type { EstateResource } from './estate';
import { rand01 } from './prng';
import type { RuleFixture } from './rule-fixture';

/** Fraction of candidate resources ever selected as violators of a given rule, by severity.
 *  Deliberately inverted from how severe/rare real-world misconfigurations usually are — a demo
 *  where "critical" findings are the rarest and "low" findings are the most common reads as a
 *  believable, well-run-but-imperfect estate; a flat rate across severities would make critical
 *  findings implausibly common. */
const SELECTION_RATE: Record<Severity, number> = {
  critical: 0.08,
  high: 0.14,
  medium: 0.22,
  low: 0.3,
  info: 0, // no demo rule uses 'info' severity; never select a violator for it
};

type LifecyclePattern = 'steady' | 'resolved-partway' | 'new-partway' | 'resolved-reactivated';

interface Schedule {
  pattern: LifecyclePattern;
  dayA?: number;
  dayB?: number;
}

/** Which of four day-based lifecycle shapes a (rule, resource) pair follows, once it's been
 *  selected as a violator at all. Weights: steady offenders dominate (most findings just sit there
 *  until someone fixes them), a quarter get resolved partway through the window (remediation
 *  actually happening), a smaller slice start partway through (drift, not everything is broken on
 *  day one), and a rare few resolve then come back (regression) — together these are what make the
 *  dashboard's trend/new-vs-fixed widgets show believable movement instead of a flat line. */
function schedulePattern(ruleId: string, resourceId: string, totalDays: number): Schedule {
  const roll = rand01(`pattern::${ruleId}::${resourceId}`);
  const span = (loKey: string, lo: number, width: number) =>
    Math.max(1, Math.min(totalDays - 1, Math.floor(totalDays * (lo + rand01(loKey) * width))));

  if (roll < 0.55) return { pattern: 'steady' };

  if (roll < 0.8) {
    return { pattern: 'resolved-partway', dayA: span(`dayA::${ruleId}::${resourceId}`, 0.2, 0.6) };
  }

  if (roll < 0.93) {
    return { pattern: 'new-partway', dayA: span(`dayA::${ruleId}::${resourceId}`, 0.2, 0.6) };
  }

  const dayA = span(`dayA::${ruleId}::${resourceId}`, 0.15, 0.3);
  const dayB = Math.max(dayA + 1, span(`dayB::${ruleId}::${resourceId}`, 0.55, 0.35));
  return { pattern: 'resolved-reactivated', dayA, dayB: Math.min(totalDays - 1, dayB) };
}

/** Pure function of (rule, resource, day) — no state, no memoization needed, so the same simulated
 *  day always produces the same answer no matter how many times it's replayed or in what order. */
export function isViolatingOnDay(
  ruleId: string,
  severity: Severity,
  resourceId: string,
  day: number,
  totalDays: number
): boolean {
  const selected = rand01(`select::${ruleId}::${resourceId}`) < SELECTION_RATE[severity];
  if (!selected) return false;

  const { pattern, dayA, dayB } = schedulePattern(ruleId, resourceId, totalDays);
  switch (pattern) {
    case 'steady':
      return true;
    case 'resolved-partway':
      return day < dayA!;
    case 'new-partway':
      return day >= dayA!;
    case 'resolved-reactivated':
      return day < dayA! || day >= dayB!;
  }
}

/** What the fake ARG returns for one rule's query on one simulated day. */
export function rowsForRuleOnDay(
  fixture: RuleFixture,
  candidates: EstateResource[],
  day: number,
  totalDays: number
): Record<string, unknown>[] {
  return candidates
    .filter(r => isViolatingOnDay(fixture.ruleId, fixture.severity, r.id, day, totalDays))
    .map(r => fixture.buildRow(r));
}
