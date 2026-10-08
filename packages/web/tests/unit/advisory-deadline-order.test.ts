/**
 * Issue #177: the pure rules behind Overdue and the Advisories order. Overdue is an open Advisory
 * whose Deadline is strictly before the clock it is given; the order is Overdue, then Deadline
 * ascending with none last, then severity.
 */
import { describe, expect, it } from 'vitest';
import { isOverdue, listsOnlyAdvisories } from '@/lib/finding-kinds';
import { compareAdvisories } from '@/lib/explorer-filters';

const NOW = new Date('2026-06-15T12:00:00.000Z');

describe('isOverdue()', () => {
  const open = { kind: 'advisory' as const, status: 'active' as const };

  it('is true for an open Advisory past its Deadline, and false at the instant of the Deadline', () => {
    expect(isOverdue({ ...open, deadline: '2026-06-15T11:59:59.999Z' }, NOW)).toBe(true);
    expect(isOverdue({ ...open, deadline: '2026-06-15T12:00:00.000Z' }, NOW)).toBe(false);
    expect(isOverdue({ ...open, deadline: '2026-06-15T12:00:00.001Z' }, NOW)).toBe(false);
  });

  it('is false with no Deadline, with an unreadable one, for a fixed finding, and for any other kind', () => {
    expect(isOverdue({ ...open }, NOW)).toBe(false);
    expect(isOverdue({ ...open, deadline: 'not a date' }, NOW)).toBe(false);
    expect(isOverdue({ ...open, status: 'fixed', deadline: '2020-01-01T00:00:00.000Z' }, NOW)).toBe(false);
    expect(isOverdue({ kind: 'state', status: 'active', deadline: '2020-01-01T00:00:00.000Z' }, NOW)).toBe(false);
    expect(isOverdue({ kind: 'activity', status: 'active', deadline: '2020-01-01T00:00:00.000Z' }, NOW)).toBe(false);
    expect(isOverdue({ status: 'active', deadline: '2020-01-01T00:00:00.000Z' }, NOW)).toBe(false);
  });

  it('treats a finding with no status as open', () => {
    expect(isOverdue({ kind: 'advisory', deadline: '2020-01-01T00:00:00.000Z' }, NOW)).toBe(true);
  });
});

describe('listsOnlyAdvisories()', () => {
  it('is true only for a listing of Advisory alone', () => {
    expect(listsOnlyAdvisories(['advisory'])).toBe(true);
    expect(listsOnlyAdvisories(undefined)).toBe(false);
    expect(listsOnlyAdvisories([])).toBe(false);
    expect(listsOnlyAdvisories(['state', 'activity'])).toBe(false);
    expect(listsOnlyAdvisories(['advisory', 'state'])).toBe(false);
  });
});

describe('compareAdvisories()', () => {
  const f = (name: string, over: { overdue?: boolean; deadline?: string; severity?: 'critical' | 'high' | 'medium' | 'low' }) =>
    ({ name, severity: 'medium' as const, ...over });
  const order = (list: ReturnType<typeof f>[]) => [...list].sort(compareAdvisories).map(x => x.name);

  it('puts Overdue before everything else, whatever the Deadlines say', () => {
    expect(order([
      f('soon', { deadline: '2026-06-10T00:00:00.000Z' }),
      f('overdue', { overdue: true, deadline: '2026-06-16T00:00:00.000Z' }),
      f('none', { severity: 'critical' }),
    ])).toEqual(['overdue', 'soon', 'none']);
  });

  it('orders by Deadline ascending and puts a finding with none last', () => {
    expect(order([
      f('none', { severity: 'critical' }),
      f('late', { deadline: '2027-01-01T00:00:00.000Z' }),
      f('early', { deadline: '2026-07-01T00:00:00.000Z' }),
    ])).toEqual(['early', 'late', 'none']);
  });

  it('breaks a tie on Deadline by severity, hottest first', () => {
    const deadline = '2026-07-01T00:00:00.000Z';
    expect(order([
      f('low', { deadline, severity: 'low' }),
      f('critical', { deadline, severity: 'critical' }),
      f('high', { deadline, severity: 'high' }),
    ])).toEqual(['critical', 'high', 'low']);
  });

  it('orders findings with no Deadline by severity', () => {
    expect(order([f('low', { severity: 'low' }), f('high', { severity: 'high' })])).toEqual(['high', 'low']);
  });
});
