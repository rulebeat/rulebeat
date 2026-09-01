/**
 * Spec 036 — the "rule-form.tsx save-gate test" named in the spec's Plan §2. This codebase has no
 * React component-rendering test layer (see toggle-set.test.ts), so rule-form.tsx's save() delegates
 * its query-shape derivation to deriveDedicatedEditorFields() and this tests that function directly,
 * the same shared-primitive pattern toggle-set.test.ts uses for the category tab strip. The behavior
 * under test is the one the spec's self-challenge flagged as risky: the pre-fix code gated the outgoing
 * payload on `isGraphBackend` alone in two separate places, which silently missed the Log Analytics
 * case in one of them. A resource-graph rule must still get its visualQuery/appliesTo/rawKql back
 * untouched, and neither dedicated-editor field set.
 */
import { describe, expect, it } from 'vitest';
import { deriveDedicatedEditorFields } from '@/lib/rule-form-payload';
import type { RuleFormQueryFields } from '@/lib/rule-form-payload';
import type { VisualQuery } from '@/lib/kql';

const VISUAL_QUERY = { stages: [] } as unknown as VisualQuery;
const APPLIES_TO = { stages: [{ id: 'g1' }] } as unknown as VisualQuery;

const FIELDS: RuleFormQueryFields = {
  visualQuery: VISUAL_QUERY,
  appliesTo: APPLIES_TO,
  rawKql: 'resources | where type == "microsoft.compute/virtualmachines"',
  graphQuery: { path: 'users' },
  logsQuery: { kql: 'SigninLogs | where ResultType != 0', timeWindowDays: 30 },
};

describe('deriveDedicatedEditorFields · rule-form.tsx save-gate payload shape (spec 036)', () => {
  it('resource-graph: keeps the ARG visual/appliesTo/rawKql fields, nulls both dedicated-editor fields', async () => {
    const result = deriveDedicatedEditorFields('resource-graph', FIELDS);
    expect(result.usesDedicatedEditor).toBe(false);
    expect(result.visualQuery).toBe(VISUAL_QUERY);
    expect(result.appliesTo).toBe(APPLIES_TO);
    expect(result.rawKql).toBe(FIELDS.rawKql);
    expect(result.graphQuery).toBeUndefined();
    expect(result.logsQuery).toBeUndefined();
  });

  it('microsoft-graph: nulls the ARG fields, sends graphQuery, still nulls logsQuery', async () => {
    const result = deriveDedicatedEditorFields('microsoft-graph', FIELDS);
    expect(result.usesDedicatedEditor).toBe(true);
    expect(result.visualQuery).toBeUndefined();
    expect(result.appliesTo).toBeUndefined();
    expect(result.rawKql).toBeUndefined();
    expect(result.graphQuery).toEqual({ path: 'users' });
    expect(result.logsQuery).toBeUndefined();
  });

  it('log-analytics: nulls the ARG fields, sends logsQuery, still nulls graphQuery — the case the pre-fix code missed', async () => {
    const result = deriveDedicatedEditorFields('log-analytics', FIELDS);
    expect(result.usesDedicatedEditor).toBe(true);
    expect(result.visualQuery).toBeUndefined();
    expect(result.appliesTo).toBeUndefined();
    expect(result.rawKql).toBeUndefined();
    expect(result.graphQuery).toBeUndefined();
    expect(result.logsQuery).toEqual(FIELDS.logsQuery);
  });

  it('an empty (whitespace-only) rawKql collapses to undefined, not a blank string, for a resource-graph rule', async () => {
    const result = deriveDedicatedEditorFields('resource-graph', { ...FIELDS, rawKql: '' });
    expect(result.rawKql).toBeUndefined();
  });
});
