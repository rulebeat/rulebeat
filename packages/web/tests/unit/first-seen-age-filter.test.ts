/**
 * The rolling first-seen filter (#406): "first seen 8 to 30 days ago" and "first seen more than 90 days
 * ago", counted in whole UTC days from the day a finding was first seen to the day the request is made.
 * It is one built-in field of the view (`firstSeenAge`), so it travels as `f=firstSeenAge=<min>-<max>`,
 * comes back from the address unchanged, and is resolved against the clock of each request: a shared
 * link keeps rolling. Driven through the view engine and the address reader and writer.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';
import { queryView } from '@/lib/db/finding-views';
import { buildAccess, parseScope } from '@/lib/access-model';
import { EVERYTHING_ACCESS } from '../helpers/access';
import {
  emptyView, filterFindings, viewFromSearchParams, viewToSearchParams, type View, type ViewFinding,
} from '@/lib/finding-view';
import { firstSeenAgeLabel } from '@/lib/first-seen-age';

function finding(firstSeenAt: string): ViewFinding {
  return {
    fingerprint: `fp-${firstSeenAt}`, category: 'security', severity: 'high', status: 'active', ruleId: 'rule-1',
    subscriptionId: 'sub-1', title: 'a finding', firstSeenAt, lastSeenAt: firstSeenAt,
  };
}

const viewWith = (value: string): View => ({ ...emptyView(), filters: [{ field: 'firstSeenAge', values: [value] }] });
const dayOf = (f: ViewFinding) => f.firstSeenAt.slice(0, 10);

/** One finding on every day from 2026-07-01 to 2026-11-07, each first seen late in the day. */
const EVERY_DAY: ViewFinding[] = [];
for (let t = Date.UTC(2026, 6, 1); t <= Date.UTC(2026, 10, 7); t += 86_400_000) {
  EVERY_DAY.push(finding(new Date(t + 86_399_000).toISOString()));
}

const NOW = new Date('2026-11-07T00:00:30.000Z');
const matching = (value: string, now: Date) => filterFindings(EVERY_DAY, viewWith(value), { now }).map(dayOf);

describe('the address', () => {
  it.each([
    ['a lower and an upper bound', 'f=firstSeenAge%3D8-30', ['8-30']],
    ['a lower bound only', 'f=firstSeenAge%3D91-', ['91-']],
    ['an upper bound only', 'f=firstSeenAge%3D-7', ['-7']],
    ['one day', 'f=firstSeenAge%3D3-3', ['3-3']],
  ])('reads %s and writes it back as it came', (_name, query, values) => {
    const view = viewFromSearchParams(new URLSearchParams(query));
    expect(view.filters).toEqual([{ field: 'firstSeenAge', values }]);
    expect(viewToSearchParams(view).toString()).toBe(query);
  });

  it('reads a blank value as no filter', () => {
    expect(viewFromSearchParams(new URLSearchParams({ f: 'firstSeenAge=' })).filters).toEqual([]);
  });

  it.each(['-', '30-8', 'abc', '8..30', '1-2-3', '-5-', '08x-9', '9999999-'])(
    'opens a link with the malformed value "%s" and keeps nothing for it, so its chip can be removed', value => {
      const view = viewFromSearchParams(new URLSearchParams({ f: `firstSeenAge=${value}` }));
      expect(view.filters).toEqual([{ field: 'firstSeenAge', values: [value] }]);
      expect(filterFindings([finding('2026-11-07T00:00:00.000Z')], view, { now: NOW })).toEqual([]);
    },
  );

  it('ignores a malformed value beside a good one', () => {
    const view = viewFromSearchParams(new URLSearchParams({ f: 'firstSeenAge=abc|0-0' }));
    expect(filterFindings(EVERY_DAY, view, { now: NOW }).map(dayOf)).toEqual(['2026-11-07']);
  });

  it('keeps it beside the other filters, and a day filter on First seen is a different filter', () => {
    const view = viewFromSearchParams(new URLSearchParams('severity=high&f=firstSeen%3D2026-01-05&f=firstSeenAge%3D8-30'));
    expect(view.filters).toEqual([
      { field: 'severity', values: ['high'] },
      { field: 'firstSeen', values: ['2026-01-05'] },
      { field: 'firstSeenAge', values: ['8-30'] },
    ]);
  });
});

describe('the bounds, on a fixed clock', () => {
  it('"8 to 30 days ago" holds the findings first seen on the 8th through the 30th UTC day back, both ends in', () => {
    // Today is 2026-11-07: 8 days back is 2026-10-30, 30 days back is 2026-10-08.
    const days = matching('8-30', NOW);
    expect(days[0]).toBe('2026-10-08');
    expect(days.at(-1)).toBe('2026-10-30');
    expect(days).toHaveLength(23);
  });

  it('"more than 90 days ago" is 91 and up, and leaves out the 90th day', () => {
    const days = matching('91-', NOW);
    expect(days.at(-1)).toBe('2026-08-08');
    expect(days).not.toContain('2026-08-09');
    expect(days[0]).toBe('2026-07-01');
  });

  it('an upper bound alone reaches back from today, and today is day 0', () => {
    expect(matching('-2', NOW)).toEqual(['2026-11-05', '2026-11-06', '2026-11-07']);
  });

  it('counts whole UTC days, not hours: a finding from 23:59 on the 8th day back is 8 days old a second after midnight', () => {
    expect(matching('8-8', NOW)).toEqual(['2026-10-30']);
    expect(matching('8-8', new Date('2026-11-07T23:59:59.000Z'))).toEqual(['2026-10-30']);
  });

  it('is resolved when the request is made: the same link on the next day holds the next day back', () => {
    expect(matching('8-8', new Date('2026-11-08T00:00:00.000Z'))).toEqual(['2026-10-31']);
    expect(matching('8-8', new Date('2026-11-06T23:59:59.999Z'))).toEqual(['2026-10-29']);
  });

  it('reads the clock when the context gives none', () => {
    const today = new Date().toISOString().slice(0, 10);
    const f = finding(`${today}T00:00:00.000Z`);
    expect(filterFindings([f], viewWith('0-0'))).toEqual([f]);
    expect(filterFindings([f], viewWith('1-'))).toEqual([]);
  });

  it('holds a finding first seen after today (a skewed clock) as 0 days old', () => {
    const future = finding('2026-11-09T10:00:00.000Z');
    expect(filterFindings([future], viewWith('0-0'), { now: NOW })).toEqual([future]);
  });

  it('accepts a finding that fits any of several ranges', () => {
    const view: View = { ...emptyView(), filters: [{ field: 'firstSeenAge', values: ['0-0', '91-'] }] };
    const days = filterFindings(EVERY_DAY, view, { now: NOW }).map(dayOf);
    expect(days).toContain('2026-11-07');
    expect(days).toContain('2026-08-08');
    expect(days).not.toContain('2026-11-06');
  });
});

describe('the chip', () => {
  it.each([
    ['8-30', '8 to 30 days ago'],
    ['91-', 'more than 90 days ago'],
    ['-7', 'up to 7 days ago'],
    ['3-3', '3 days ago'],
    ['1-', '1 or more days ago'],
    ['0-0', 'today'],
  ])('says %s as "%s"', (value, label) => {
    expect(firstSeenAgeLabel(value)).toBe(label);
  });
});

describe('the server view', () => {
  beforeAll(async () => {
    await resetDb();
    const at = (name: string, day: string) => storeScan(
      [syntheticFinding(name, [{ n: 1 }], { ruleId: `age-rule-${name}` })],
      { scanId: `scan-${name}`, finishedAt: `${day}T12:00:00.000Z` },
    );
    await at('old', '2026-07-01');
    await at('month', '2026-10-15');
    await at('week', '2026-10-31');
    await at('today', '2026-11-07');
  });
  afterEach(() => vi.useRealTimers());

  async function names(value: string, now: string) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now));
    const response = await queryView(viewWith(value), { tab: 'results', showSuppressed: false }, EVERYTHING_ACCESS);
    return { names: response.items.map(i => i.finding.resourceName).sort(), total: response.total };
  }

  it('lists the findings first seen in the range, counted from the day of the request', async () => {
    expect(await names('8-30', '2026-11-07T08:00:00.000Z')).toEqual({ names: ['month'], total: 1 });
    expect(await names('91-', '2026-11-07T08:00:00.000Z')).toEqual({ names: ['old'], total: 1 });
  });

  it('narrows by the viewer\'s Access like every other filter', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-07T08:00:00.000Z'));
    const nobody = buildAccess([{ tenantId: 't', scope: parseScope('/subscriptions/other-sub')!, role: 'viewer' }], 'manual');
    const response = await queryView(viewWith('8-30'), { tab: 'results', showSuppressed: false }, nobody);
    expect(response.total).toBe(0);
  });

  it('moves with the clock: the same filter a week later holds different findings', async () => {
    // On 2026-11-14 the 15th of October is 30 days back, the 31st is 14 and the 7th is 7: still too new.
    expect(await names('8-30', '2026-11-14T08:00:00.000Z')).toEqual({ names: ['month', 'week'], total: 2 });
  });
});
