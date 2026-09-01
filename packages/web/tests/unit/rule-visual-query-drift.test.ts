/**
 * Spec 016 (RB-QA-008) · rule-form.tsx's stale-visualQuery self-heal.
 *
 * `isVisualQueryStale()` is the pure logic behind rule-form.tsx's visualQuery initializer: a rule
 * opened and saved before the union-passthrough fix shipped has a stored visualQuery blob missing the
 * `raw` stage its own rawKql actually contains — regenerating from that stale blob would drop the
 * union clause a second time, right back to the RB-QA-008 bug, even though the parser itself is fixed.
 */
import { describe, expect, it } from 'vitest';
import { parseKqlToVisualQuery } from '@/lib/kql';
import { isVisualQueryStale } from '@/lib/rule-visual-query-drift';

// The resource-type filter is written in the generator's own canonical form (`in~ (...)`, not
// `=~`) so a freshly-parsed round trip is genuinely byte-stable — otherwise the normalization the
// generator always applies would itself look like drift, unrelated to the union stage under test.
const RAW_KQL = [
  'Resources',
  "| where type in~ ('microsoft.compute/virtualmachines')",
  "| union (Resources | where type =~ 'microsoft.compute/disks')",
  '| project id',
].join('\n');

describe('spec 016 · isVisualQueryStale', () => {
  it('flags a pre-fix stored visualQuery (missing the union raw stage) as stale', async () => {
    // Simulates a blob saved before the union fix: a filter stage but no RawStage for the union —
    // exactly what the old parser would have produced and stored.
    const staleStoredVisualQuery = {
      stages: [
        { id: 'f1', type: 'filter' as const, groups: [{ id: 'g1', conditions: [] }] },
      ],
    };

    const stale = isVisualQueryStale({
      storedVisualQuery: staleStoredVisualQuery,
      storedRawKql: RAW_KQL,
      scope: { level: 'resource' },
      resourceTypes: ['*'],
      projectColumns: ['id'],
    });
    expect(stale).toBe(true);
  });

  it('does not flag a freshly-parsed visualQuery (with its union raw stage) as stale', async () => {
    const parsed = parseKqlToVisualQuery(RAW_KQL);

    const stale = isVisualQueryStale({
      storedVisualQuery: parsed.visualQuery,
      storedRawKql: RAW_KQL,
      scope: parsed.scope,
      resourceTypes: parsed.resourceTypes,
      projectColumns: parsed.projectColumns,
    });
    expect(stale).toBe(false);
  });
});
