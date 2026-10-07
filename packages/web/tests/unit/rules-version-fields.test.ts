/**
 * Ticket #163: the repository carries a rule's version, retirement and origin through reads and
 * writes, keeps `updateRule()` away from them (only the seeder and a version switch set them), and
 * records where a duplicate came from. Through the real database, on whichever backend the suite
 * runs against.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Rule } from '@rulebeat/core';
import { duplicateRule, loadRules, saveRules, updateRule, type RuleChanges } from '@/lib/rules';
import { resetDb } from '../helpers/db';

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: globalThis.crypto.randomUUID(),
    name: 'version fields ' + Math.random().toString(36).slice(2),
    description: 'a test rule',
    category: 'security',
    severity: 'medium',
    enabled: true,
    type: 'custom',
    scope: { level: 'subscription' },
    resourceTypes: ['microsoft.compute/virtualmachines'],
    conditions: [],
    rawKql: 'resources | where type == "microsoft.compute/virtualmachines"',
    queryBackend: 'resource-graph',
    kind: 'state',
    ...overrides,
  };
}

async function find(id: string): Promise<Rule> {
  const rule = (await loadRules()).find(r => r.id === id);
  if (!rule) throw new Error(`rule ${id} not stored`);
  return rule;
}

describe('rule version fields', () => {
  beforeEach(async () => { await resetDb(); });

  it('reads back the version, retirement and origin a rule was saved with', async () => {
    const rule = makeRule({
      type: 'builtin', pack: 'aprl-v2', version: '2026-06-08T13:06:47Z', retiredAt: '2026-07-01T00:00:00.000Z',
    });
    const converted = makeRule({ originRuleId: 'cred:app-secret-expiring', originVersion: '1.0.0' });
    await saveRules([rule, converted]);

    const [a, b] = [await find(rule.id), await find(converted.id)];
    expect([a.version, a.retiredAt, a.originRuleId, a.originVersion]).toEqual(['2026-06-08T13:06:47Z', '2026-07-01T00:00:00.000Z', undefined, undefined]);
    expect([b.version, b.retiredAt, b.originRuleId, b.originVersion]).toEqual([undefined, undefined, 'cred:app-secret-expiring', '1.0.0']);
  });

  it('never lets updateRule() write them, even if a caller casts them in', async () => {
    const rule = makeRule({ type: 'builtin', pack: 'rulebeat-core', version: '1.0.0' });
    await saveRules([rule]);

    const sneaky = { severity: 'high', version: '9.9.9', retiredAt: 'now', originRuleId: 'x', originVersion: 'y' } as RuleChanges;
    await updateRule(rule.id, sneaky);

    const after = await find(rule.id);
    expect(after.severity).toBe('high');
    expect([after.version, after.retiredAt, after.originRuleId, after.originVersion]).toEqual(['1.0.0', undefined, undefined, undefined]);
  });

  it('makes a duplicate of a shipped rule a custom rule that remembers its origin, with no version of its own', async () => {
    const shipped = makeRule({
      type: 'builtin', pack: 'aprl-v2', version: '2026-06-08T13:06:47Z', retiredAt: '2026-07-01T00:00:00.000Z',
    });
    await saveRules([shipped]);

    const copy = await duplicateRule(shipped.id);
    expect(copy).not.toBeNull();
    const stored = await find(copy!.id);
    expect(stored.type).toBe('custom');
    expect([stored.version, stored.retiredAt]).toEqual([undefined, undefined]);
    expect([stored.originRuleId, stored.originVersion]).toEqual([shipped.id, '2026-06-08T13:06:47Z']);
  });

  it('keeps the origin of a custom rule when it is duplicated', async () => {
    const custom = makeRule({ originRuleId: 'cred:app-secret-expiring', originVersion: '1.0.0' });
    await saveRules([custom]);

    const copy = await duplicateRule(custom.id);
    const stored = await find(copy!.id);
    expect([stored.originRuleId, stored.originVersion]).toEqual(['cred:app-secret-expiring', '1.0.0']);
  });
});
