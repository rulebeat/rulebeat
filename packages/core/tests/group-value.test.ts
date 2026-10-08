/**
 * Issue #178: an Advisory's group is read from the column a rule names. A usable value becomes the
 * finding's group; a blank, missing or structured one is no group, and the rule still ends `success`.
 */
import { describe, expect, it } from 'vitest';
import type { TokenCredential } from '@azure/identity';
import { parseGroupValue } from '../src/group-value.js';
import { runRules } from '../src/engine/runner.js';
import type { Rule, RuleRunEvent } from '../src/engine/types.js';
import type { Finding, TenantContext } from '../src/types.js';

describe('parseGroupValue()', () => {
  it('trims a string and reads a number or boolean as its text', () => {
    expect(parseGroupValue('  Basic SKU IP  ')).toBe('Basic SKU IP');
    expect(parseGroupValue(42)).toBe('42');
    expect(parseGroupValue(true)).toBe('true');
  });

  it.each([
    ['empty', ''], ['whitespace', '   '], ['null', null], ['undefined', undefined],
    ['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY],
    ['an object', { a: 1 }], ['an array', ['a']],
  ])('is no group for %s', (_label, input) => {
    expect(parseGroupValue(input)).toBeNull();
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
    rawKql: 'advisorresources | project id, name, type, location, resourceGroup, subscriptionId, feature',
    kind: 'advisory', groupField: 'feature',
    ...overrides,
  };
}

const row = (n: number, feature: unknown): Record<string, unknown> => ({
  id: `/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm${n}`,
  name: `vm${n}`, type: 'microsoft.compute/virtualmachines', location: 'eastus',
  resourceGroup: 'rg', subscriptionId: 'sub-1', feature,
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

describe('runRules() and the Group column', () => {
  it('stamps each Advisory finding with its group value and ends success when some rows have none', async () => {
    const events = await drain(rule(), [row(1, 'Basic SKU IP'), row(2, '  Basic SKU IP '), row(3, ''), row(4, null), row(5, { x: 1 })]);
    expect(findings(events).map(f => f.groupValue)).toEqual(['Basic SKU IP', 'Basic SKU IP', undefined, undefined, undefined]);
    expect(outcome(events)).toEqual([{ ruleId: 'r', status: 'success', findingCount: 5 }]);
  });

  it('ignores the Group column on a Problem rule', async () => {
    const events = await drain(rule({ kind: 'state' }), [row(1, 'Basic SKU IP')]);
    expect(findings(events)[0]?.groupValue).toBeUndefined();
  });

  it('sets no group when the rule names no column', async () => {
    const events = await drain(rule({ groupField: undefined }), [row(1, 'Basic SKU IP')]);
    expect(findings(events)[0]?.groupValue).toBeUndefined();
  });

  it('leaves the fingerprint alone, so grouping never changes which findings exist', async () => {
    const grouped = findings(await drain(rule(), [row(1, 'A'), row(2, 'B')]));
    const flat = findings(await drain(rule({ groupField: undefined }), [row(1, 'A'), row(2, 'B')]));
    expect(grouped.map(f => f.fingerprint)).toEqual(flat.map(f => f.fingerprint));
  });
});
