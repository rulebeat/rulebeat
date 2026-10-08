/**
 * A built-in rule's kind is part of its versioned definition (ADR 0005, amended). This file used to
 * assert the opposite (issue #176: kind belonged to the install and no version could change it);
 * it now pins how the version plan reads a stored kind: as one more definition field, so a row whose
 * kind differs from what ships is a different definition, and an apply writes the shipped kind.
 */
import { describe, expect, it } from 'vitest';
import { catalogueOf, shippedRule } from '../helpers/catalogue';
import { planRuleSeeding, versionKey, type StoredRuleRow } from '@/lib/rule-versions';
import { BEFORE_VERSIONING } from '@/lib/before-versioning';

const ID = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const v1 = shippedRule({ id: ID });
const v2 = shippedRule({
  id: ID, version: '2.0.0', releaseNote: 'Ships as an Advisory.',
  definition: { kind: 'advisory', rawKql: 'Resources | where name == "new" | project id' },
});

const rowOf = (over: Partial<StoredRuleRow>): StoredRuleRow => {
  const d = v1.definition;
  return {
    id: ID, name: d.name, description: d.description, category: d.category, severity: d.severity,
    enabled: true, scope: JSON.stringify(d.scope), resourceTypes: JSON.stringify(d.resourceTypes),
    conditions: JSON.stringify(d.conditions), conditionGroups: null, visualQuery: null, projectColumns: null,
    rawKql: d.rawKql, queryBackend: d.queryBackend, kind: d.kind, graphQuery: null, logsQuery: null,
    type: 'builtin', pack: v1.pack, version: null, retiredAt: null, originRuleId: null, ...over,
  };
};

describe('planRuleSeeding and a built-in rule\'s kind', () => {
  it('records an enabled row with no version as the shipped version when its kind matches', () => {
    const actions = planRuleSeeding({ catalogue: catalogueOf(v1), rows: [rowOf({})], recorded: new Set() });
    expect(actions.map(a => a.action)).toContain('set-running');
    expect(JSON.stringify(actions)).not.toContain(BEFORE_VERSIONING);
  });

  it('keeps an enabled row whose kind differs from what ships running as Before versioning', () => {
    const actions = planRuleSeeding({ catalogue: catalogueOf(v1), rows: [rowOf({ kind: 'advisory' })], recorded: new Set() });
    expect(actions).toContainEqual({ action: 'set-running', ruleId: ID, version: BEFORE_VERSIONING });
    expect(actions.find(a => a.action === 'record' && a.version === BEFORE_VERSIONING))
      .toMatchObject({ definition: { kind: 'advisory' } });
  });

  it('moves a disabled row to a version that ships a different kind, carrying that kind', () => {
    const actions = planRuleSeeding({
      catalogue: catalogueOf(v2), rows: [rowOf({ enabled: false, version: '1.0.0' })], recorded: new Set([versionKey(ID, '1.0.0')]),
    });
    expect(actions.find(a => a.action === 'apply')).toMatchObject({ rule: { definition: { kind: 'advisory' } } });
  });
});
