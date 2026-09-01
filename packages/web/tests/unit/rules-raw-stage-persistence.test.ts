/**
 * Spec 016 (RB-QA-008): a rule whose visualQuery contains a RawStage (the passthrough produced for
 * `| union (...)`) must survive the round trip through SQLite exactly — `ruleToRow`/`rowToRule`
 * (lib/rules.ts) JSON.stringify/parse the visualQuery blob as one column, so a stage type the DB
 * layer has never heard of is exactly the kind of thing that silently drops if the JSON shape isn't
 * preserved end to end.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Rule, VisualQuery } from '@rulebeat/core';
import { loadRules, saveRules } from '@/lib/rules';
import { clearRules } from '../helpers/db';

function ruleWithRawStage(): Rule {
  const visualQuery: VisualQuery = {
    stages: [
      { id: 'f1', type: 'filter', groups: [{ id: 'g1', conditions: [] }] },
      { id: 'r1', type: 'raw', clause: "union (Resources | where type =~ 'microsoft.compute/disks')" },
      { id: 's1', type: 'shape', mode: 'project', columns: ['id', 'name'] },
    ],
  };

  return {
    id: 'raw-stage-persistence-test',
    name: 'raw stage persistence test',
    description: 'test',
    category: 'security',
    severity: 'medium',
    enabled: true,
    type: 'custom',
    scope: { level: 'subscription' },
    resourceTypes: [],
    conditions: [],
    rawKql: [
      'Resources',
      "| where type =~ 'microsoft.compute/virtualmachines'",
      "| union (Resources | where type =~ 'microsoft.compute/disks')",
      '| project id, name',
    ].join('\n'),
    visualQuery,
  };
}

describe('spec 016 · RawStage survives lib/rules.ts persistence', () => {
  beforeEach(async () => {
    await clearRules();
  });

  it('round-trips a visualQuery containing a RawStage byte-identical', async () => {
    const rule = ruleWithRawStage();
    await saveRules([rule]);

    const reloaded = (await loadRules()).find(r => r.id === rule.id);
    expect(reloaded).toBeDefined();
    expect(reloaded!.visualQuery).toEqual(rule.visualQuery);

    const rawStage = reloaded!.visualQuery!.stages.find(s => s.type === 'raw');
    expect(rawStage).toEqual({
      id: 'r1',
      type: 'raw',
      clause: "union (Resources | where type =~ 'microsoft.compute/disks')",
    });
  });
});
