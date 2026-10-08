/**
 * Issue #177: an Advisory's Deadline is read from the column a rule names. ISO strings and epoch
 * numbers (seconds or milliseconds) parse; anything else is no Deadline, and the rule still ends
 * `success`.
 */
import { describe, expect, it } from 'vitest';
import type { TokenCredential } from '@azure/identity';
import { parseDeadline, EPOCH_MILLISECONDS_CUTOFF } from '../src/deadline.js';
import { runRules } from '../src/engine/runner.js';
import type { Rule, RuleRunEvent } from '../src/engine/types.js';
import type { Finding, TenantContext } from '../src/types.js';

describe('parseDeadline()', () => {
  it.each([
    ['2027-03-01T10:30:00Z', '2027-03-01T10:30:00.000Z'],
    ['2027-03-01T10:30:00.250Z', '2027-03-01T10:30:00.250Z'],
    ['2027-03-01T12:30:00+02:00', '2027-03-01T10:30:00.000Z'],
    ['2027-03-01T10:30:00', '2027-03-01T10:30:00.000Z'],
    ['2027-03-01 10:30:00', '2027-03-01T10:30:00.000Z'],
    ['2027-03-01', '2027-03-01T00:00:00.000Z'],
    ['  2027-03-01  ', '2027-03-01T00:00:00.000Z'],
  ])('reads the ISO string %s', (input, expected) => {
    expect(parseDeadline(input)).toBe(expected);
  });

  it('reads an epoch in seconds as a number or an all-digit string', () => {
    expect(parseDeadline(1_803_000_000)).toBe('2027-02-19T01:20:00.000Z');
    expect(parseDeadline('1803000000')).toBe('2027-02-19T01:20:00.000Z');
  });

  it('reads an epoch in milliseconds as a number or an all-digit string', () => {
    expect(parseDeadline(1_803_000_000_000)).toBe('2027-02-19T01:20:00.000Z');
    expect(parseDeadline('1803000000000')).toBe('2027-02-19T01:20:00.000Z');
  });

  it('puts the seconds and milliseconds cutoff at 1e11', () => {
    expect(EPOCH_MILLISECONDS_CUTOFF).toBe(1e11);
    expect(parseDeadline(99_999_999_999)).toBe('5138-11-16T09:46:39.000Z');
    expect(parseDeadline(100_000_000_000)).toBe('1973-03-03T09:46:40.000Z');
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['a phrase', 'sometime next year'],
    ['a phrase a lenient parser would accept', 'Retire 2027'],
    ['a month name', 'March 1, 2027'],
    ['an impossible month', '2027-13-01'],
    ['an impossible day', '2027-02-30'],
    ['a year alone', '2027'],
    ['a small number', 42],
    ['zero', 0],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an epoch past year 9999', 9e14],
    ['null', null],
    ['undefined', undefined],
    ['a boolean', true],
    ['an object', { date: '2027-03-01' }],
    ['an invalid Date', new Date('nope')],
  ])('gives no Deadline for %s', (_label, input) => {
    expect(parseDeadline(input)).toBeNull();
  });
});

function ctx(rows: Record<string, unknown>[]): TenantContext {
  return {
    tenantId: 't',
    subscriptionIds: ['sub-1'],
    credential: {} as TokenCredential,
    log: () => undefined,
    queryARG: async () => rows,
  } as TenantContext;
}

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'r', name: 'R', description: 'd', category: 'reliability', severity: 'medium', enabled: true,
    type: 'custom', scope: { level: 'subscription' }, resourceTypes: [], conditions: [],
    rawKql: 'advisorresources | project id, name, type, location, resourceGroup, subscriptionId, retireOn',
    kind: 'advisory', deadlineField: 'retireOn',
    ...overrides,
  };
}

const row = (n: number, retireOn: unknown): Record<string, unknown> => ({
  id: `/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm${n}`,
  name: `vm${n}`, type: 'microsoft.compute/virtualmachines', location: 'eastus',
  resourceGroup: 'rg', subscriptionId: 'sub-1', retireOn,
});

async function drain(r: Rule, rows: Record<string, unknown>[]): Promise<RuleRunEvent<Finding>[]> {
  const out: RuleRunEvent<Finding>[] = [];
  for await (const event of runRules([r], ctx(rows))) out.push(event);
  return out;
}

const findings = (events: RuleRunEvent<Finding>[]) =>
  events.flatMap(e => (e.kind === 'finding' ? [e.finding] : []));
const outcome = (events: RuleRunEvent<Finding>[]) =>
  events.flatMap(e => (e.kind === 'outcome' ? [e.outcome] : []));

describe('runRules() and the Deadline column', () => {
  it('stamps each Advisory finding with the parsed Deadline and ends success even with an unparseable value', async () => {
    const events = await drain(rule(), [
      row(1, '2027-03-01T00:00:00Z'), row(2, 1_803_000_000), row(3, 'someday'), row(4, null),
    ]);
    expect(findings(events).map(f => f.deadline)).toEqual([
      '2027-03-01T00:00:00.000Z', '2027-02-19T01:20:00.000Z', undefined, undefined,
    ]);
    expect(outcome(events)).toEqual([{ ruleId: 'r', status: 'success', findingCount: 4 }]);
  });

  it('ignores the Deadline column on a Problem rule', async () => {
    const events = await drain(rule({ kind: 'state' }), [row(1, '2027-03-01T00:00:00Z')]);
    expect(findings(events)[0]?.deadline).toBeUndefined();
  });

  it('sets no Deadline when the rule names no column', async () => {
    const events = await drain(rule({ deadlineField: undefined }), [row(1, '2027-03-01T00:00:00Z')]);
    expect(findings(events)[0]?.deadline).toBeUndefined();
  });
});
