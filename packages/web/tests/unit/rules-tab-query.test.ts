/**
 * The Rules tab's filters in the link: status, last run, reach and category are read from the query the
 * page and the client share, written back in the same encoding without touching the Results tab's params,
 * and applied to the list by one function, so the Scan Coverage count and the list it opens agree.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_RULES_FILTER, INCOMPLETE_LAST_RUNS, lastRunOf, matchesRulesTabFilter, readRulesTabFilter, rulesTabHref, writeRulesTabFilter,
  type RulesTabFilter,
} from '@/lib/rules-tab-query';

const read = (query: string) => readRulesTabFilter(new URLSearchParams(query));
const FILTER: RulesTabFilter = { status: 'enabled', lastRun: ['failed', 'capped', 'invalid'], reach: true, categories: ['security', 'cost'] };

describe('reading the Rules tab filters', () => {
  it('reads nothing as no filter', () => {
    expect(read('tab=rules')).toEqual(EMPTY_RULES_FILTER);
  });

  it('reads status, last run, reach and category', () => {
    expect(read('tab=rules&category=security,cost&status=enabled&lastRun=failed|capped|invalid&reach=yours')).toEqual(FILTER);
  });

  it('ignores a value it does not know, including the Results tab\'s own status', () => {
    expect(read('tab=rules&status=active&lastRun=exploded&reach=all')).toEqual(EMPTY_RULES_FILTER);
    expect(read('status=disabled&lastRun=not-run|success').status).toBe('disabled');
    expect(read('lastRun=not-run|success').lastRun).toEqual(['not-run', 'success']);
  });

  it('reads a page\'s search params record the same way', () => {
    const record = { tab: 'rules', status: 'enabled', lastRun: 'failed', reach: ['yours'], category: 'security' };
    expect(readRulesTabFilter(record)).toEqual({ status: 'enabled', lastRun: ['failed'], reach: true, categories: ['security'] });
  });
});

describe('writing the Rules tab filters', () => {
  it('round-trips every filter through the link', () => {
    expect(read(writeRulesTabFilter('tab=rules', FILTER))).toEqual(FILTER);
    expect(read(writeRulesTabFilter('tab=rules', EMPTY_RULES_FILTER))).toEqual(EMPTY_RULES_FILTER);
  });

  it('keeps every param it does not own, including the Results tab\'s', () => {
    const results = 'tab=rules&severity=high&subscription=abc&q=vm&window=30&f=placement%3Dresource';
    const written = new URLSearchParams(writeRulesTabFilter(results, FILTER));
    for (const key of ['tab', 'severity', 'subscription', 'q', 'window', 'f']) {
      expect(written.get(key), key).toBe(new URLSearchParams(results).get(key));
    }
  });

  it('removes what it wrote when the filter is cleared, and leaves a Results status of its own alone', () => {
    const written = writeRulesTabFilter('tab=rules&severity=high', FILTER);
    expect(writeRulesTabFilter(written, EMPTY_RULES_FILTER)).toBe('tab=rules&severity=high');
    expect(writeRulesTabFilter('tab=rules&status=fixed', EMPTY_RULES_FILTER)).toBe('tab=rules&status=fixed');
    expect(writeRulesTabFilter('tab=rules&status=enabled', EMPTY_RULES_FILTER)).toBe('tab=rules');
  });

  it('builds the link the Scan Coverage count opens', () => {
    const href = rulesTabHref({ ...EMPTY_RULES_FILTER, status: 'enabled', lastRun: [...INCOMPLETE_LAST_RUNS], categories: ['security'], reach: true });
    const url = new URL(href, 'http://localhost');
    expect(url.pathname).toBe('/scans');
    expect(url.searchParams.get('tab')).toBe('rules');
    expect(read(url.search)).toEqual({ status: 'enabled', lastRun: ['failed', 'capped', 'invalid'], reach: true, categories: ['security'] });
  });
});

describe('applying the filters to a rule', () => {
  const rule = (over: Partial<{ id: string; category: string; enabled: boolean; lastRunStatus: 'success' | 'failed' | 'capped' | 'invalid' }> = {}) =>
    ({ id: 'r', category: 'security', enabled: true, ...over });
  const inReach = new Set(['r']);

  it('names a rule that has never run not-run', () => {
    expect(lastRunOf(rule())).toBe('not-run');
    expect(lastRunOf(rule({ lastRunStatus: 'capped' }))).toBe('capped');
  });

  it('matches on each filter alone', () => {
    const f = (over: Partial<RulesTabFilter>) => ({ ...EMPTY_RULES_FILTER, ...over });
    expect(matchesRulesTabFilter(rule(), EMPTY_RULES_FILTER)).toBe(true);
    expect(matchesRulesTabFilter(rule({ enabled: false }), f({ status: 'enabled' }))).toBe(false);
    expect(matchesRulesTabFilter(rule({ enabled: false }), f({ status: 'disabled' }))).toBe(true);
    expect(matchesRulesTabFilter(rule({ category: 'cost' }), f({ categories: ['security'] }))).toBe(false);
    expect(matchesRulesTabFilter(rule({ lastRunStatus: 'failed' }), f({ lastRun: ['failed'] }))).toBe(true);
    expect(matchesRulesTabFilter(rule({ lastRunStatus: 'success' }), f({ lastRun: ['failed', 'capped'] }))).toBe(false);
    expect(matchesRulesTabFilter(rule(), f({ lastRun: ['not-run'] }))).toBe(true);
    expect(matchesRulesTabFilter(rule(), f({ lastRun: ['failed', 'capped', 'invalid'] }))).toBe(false);
  });

  it('keeps reach for someone who has a set of rules in reach, and ignores it for Everything, who has none', () => {
    const f = { ...EMPTY_RULES_FILTER, reach: true };
    expect(matchesRulesTabFilter(rule({ id: 'outside' }), f, inReach)).toBe(false);
    expect(matchesRulesTabFilter(rule(), f, inReach)).toBe(true);
    expect(matchesRulesTabFilter(rule({ id: 'outside' }), f, undefined)).toBe(true);
  });
});
