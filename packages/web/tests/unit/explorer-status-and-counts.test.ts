/**
 * The Results tab's status filter, by-rule Open/New/Fixed counts, header tiles, and filter-dropdown counts.
 *
 * Contract: Open is every open finding whatever the window or status picked; New and Fixed are
 * both bounded by the window; and a dropdown's counts follow every filter except its own, status
 * included, so they add up to what the table shows.
 */
import { describe, expect, it } from 'vitest';
import type { ExplorerFinding } from '@/lib/explorer-data';
import {
  matchesExplorerFilters, countFindingsByRule, facetPool, parseExplorerStatus, summarizeFindings, EXPLORER_SEVERITIES,
  type ExplorerFilterState,
} from '@/lib/explorer-filters';

const FROM = '2026-10-01';
const TO = '2026-10-07';

function f(id: string, overrides: Partial<ExplorerFinding>): ExplorerFinding {
  return {
    module: 'compliance', category: 'compliance', fingerprint: id, ruleId: 'rule-a', resourceId: `/subscriptions/sub-1/x/${id}`,
    resourceType: 'microsoft.compute/virtualmachines', resourceName: id, subscriptionId: 'sub-1',
    title: 't', description: 'd', evidence: {}, recommendation: 'r', remediationSteps: [], detectedAt: '2026-10-07T00:00:00.000Z',
    severity: 'medium', status: 'active', firstSeenAt: '2026-09-01T00:00:00.000Z', lastSeenAt: '2026-10-07T00:00:00.000Z',
    timesSeen: 1, policyName: 'Rule A', ruleDisabled: false, ruleTags: [],
    ...overrides,
  };
}

// rule-a: one old open, one new open, one fixed inside the window, one fixed long ago.
// rule-b: one new open in sub-2.
const OLD_OPEN = f('old-open', {});
const NEW_OPEN = f('new-open', { firstSeenAt: '2026-10-06T00:00:00.000Z' });
const FIXED_RECENT = f('fixed-recent', { status: 'fixed', resolvedAt: '2026-10-05T00:00:00.000Z' });
const FIXED_OLD = f('fixed-old', { status: 'fixed', resolvedAt: '2026-08-01T00:00:00.000Z' });
const B_NEW = f('b-new', { ruleId: 'rule-b', subscriptionId: 'sub-2', firstSeenAt: '2026-10-06T00:00:00.000Z' });
const ALL = [OLD_OPEN, NEW_OPEN, FIXED_RECENT, FIXED_OLD, B_NEW];

function state(overrides: Partial<ExplorerFilterState> = {}): ExplorerFilterState {
  return {
    showSuppressed: false, suppressedFingerprints: new Set(), categories: new Set(), severities: new Set(),
    status: 'open', ruleIds: new Set(), subscriptions: new Set(), resourceGroups: new Set(), locations: new Set(),
    tags: new Set(), search: '', rangeFrom: FROM, rangeTo: TO,
    ...overrides,
  };
}

const shown = (s: ExplorerFilterState) => ALL.filter(x => matchesExplorerFilters(x, s)).map(x => x.fingerprint).sort();

describe('status filter', () => {
  it('Open is every open finding, old or new', () => {
    expect(shown(state({ status: 'open' }))).toEqual(['b-new', 'new-open', 'old-open']);
  });

  it('New is open findings first seen inside the window', () => {
    expect(shown(state({ status: 'new' }))).toEqual(['b-new', 'new-open']);
  });

  it('Fixed is only findings fixed inside the window, matching the Fixed tile', () => {
    expect(shown(state({ status: 'fixed' }))).toEqual(['fixed-recent']);
  });

  it('All is open plus fixed inside the window', () => {
    expect(shown(state({ status: 'all' }))).toEqual(['b-new', 'fixed-recent', 'new-open', 'old-open']);
  });

  it('reads the removed "active" option, and anything unknown, as Open', () => {
    expect(parseExplorerStatus('active')).toBe('open');
    expect(parseExplorerStatus(undefined)).toBe('open');
    expect(parseExplorerStatus('nonsense')).toBe('open');
    expect(parseExplorerStatus('new')).toBe('new');
    expect(parseExplorerStatus('fixed')).toBe('fixed');
    expect(parseExplorerStatus('all')).toBe('all');
  });
});

describe('by-rule counts', () => {
  it('Open counts every open finding, New is a subset of it, Fixed is inside the window', () => {
    const counts = countFindingsByRule(ALL, FROM, TO);
    expect(counts.get('rule-a')).toEqual({ open: 2, new: 1, fixed: 1 });
    expect(counts.get('rule-b')).toEqual({ open: 1, new: 1, fixed: 0 });
  });

  it('Open does not change with the window', () => {
    const wide = countFindingsByRule(ALL, '2026-01-01', TO).get('rule-a');
    const narrow = countFindingsByRule(ALL, TO, TO).get('rule-a');
    expect(wide?.open).toBe(2);
    expect(narrow?.open).toBe(2);
    expect(wide?.new).toBe(2);
    expect(narrow?.new).toBe(0);
  });
});

describe('filter dropdown counts', () => {
  it('the subscription dropdown follows the status filter and never counts out-of-window fixed findings', () => {
    const pool = facetPool(ALL, state({ status: 'new' }), 'subscription');
    expect(pool.map(x => x.fingerprint).sort()).toEqual(['b-new', 'new-open']);
  });

  it('the subscription dropdown follows the severity filter', () => {
    const critical = f('crit', { severity: 'critical' });
    const pool = facetPool([...ALL, critical], state({ severities: new Set(['critical']) }), 'subscription');
    expect(pool.map(x => x.fingerprint)).toEqual(['crit']);
  });

  it('picking a subscription keeps the other subscriptions in its own dropdown', () => {
    const pool = facetPool(ALL, state({ subscriptions: new Set(['sub-1']) }), 'subscription');
    expect(new Set(pool.map(x => x.subscriptionId))).toEqual(new Set(['sub-1', 'sub-2']));
  });
});

describe('finding-level totals include state findings only, not activity or a future kind', () => {
  const ACTIVITY_OPEN = f('activity-open', { kind: 'activity', resourceId: undefined, dimensionKey: 'dim-a' });
  // Stands in for a kind that does not exist yet (e.g. 'advisory', ADR 0005), cast past the type
  // system since ExplorerFinding's kind has no third member today.
  const FUTURE_KIND_OPEN = f('future-kind-open', {
    kind: 'advisory' as unknown as ExplorerFinding['kind'], resourceId: undefined, dimensionKey: 'dim-b',
  });

  it('the header tiles leave an activity finding out, the same as posture does', () => {
    const withoutActivity = summarizeFindings(ALL, FROM, TO);
    const withActivity = summarizeFindings([...ALL, ACTIVITY_OPEN], FROM, TO);
    expect(withActivity).toEqual(withoutActivity);
  });

  it('the header tiles exclude a future-kind finding entirely, not just from its own severity, from `total` too', () => {
    const withoutFutureKind = summarizeFindings(ALL, FROM, TO);
    const withFutureKind = summarizeFindings([...ALL, FUTURE_KIND_OPEN], FROM, TO);
    expect(withFutureKind).toEqual(withoutFutureKind);
  });

  it('both still show in the table', () => {
    expect(matchesExplorerFilters(ACTIVITY_OPEN, state({ status: 'open' }))).toBe(true);
    expect(matchesExplorerFilters(FUTURE_KIND_OPEN, state({ status: 'open' }))).toBe(true);
  });

  it('by-rule Open sums to the same total as the Open tile, for a pool with state, activity and a future kind', () => {
    const pool = [...ALL, ACTIVITY_OPEN, FUTURE_KIND_OPEN];
    const tileOpen = summarizeFindings(pool, FROM, TO).total;
    const byRuleOpen = [...countFindingsByRule(pool, FROM, TO).values()].reduce((n, c) => n + c.open, 0);
    expect(byRuleOpen).toBe(tileOpen);
  });
});

describe('header tiles', () => {
  const INFO_OPEN = f('info-open', { severity: 'info' });
  const LOW_OPEN = f('low-open', { severity: 'low' });

  it('there is a severity tile and filter button for Info', () => {
    expect(EXPLORER_SEVERITIES).toEqual(['critical', 'high', 'medium', 'low', 'info']);
  });

  it('the severity tiles add up to Open, Info included', () => {
    const stats = summarizeFindings([...ALL, INFO_OPEN, LOW_OPEN], FROM, TO);
    const tileSum = EXPLORER_SEVERITIES.reduce((n, sev) => n + stats.counts[sev], 0);
    expect(stats.total).toBe(5);
    expect(stats.counts.info).toBe(1);
    expect(tileSum).toBe(stats.total);
  });

  it('the Info filter shows only open Info findings', () => {
    const pool = [...ALL, INFO_OPEN, LOW_OPEN];
    const picked = pool.filter(x => matchesExplorerFilters(x, state({ severities: new Set(['info']) })));
    expect(picked.map(x => x.fingerprint)).toEqual(['info-open']);
  });
});
