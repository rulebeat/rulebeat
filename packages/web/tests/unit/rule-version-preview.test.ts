import { describe, expect, it } from 'vitest';
import { diffQueryLines, versionLabel } from '@/lib/rule-version-preview';
import { changedFields } from '@/lib/changed-fields';
import type { RuleVersionDefinition } from '@/lib/types';
import { shippedRule } from '../helpers/catalogue';

describe('Rule version review', () => {
  it('shows unchanged lines, removals and additions in query order, including repeated lines and empty queries', () => {
    expect(diffQueryLines('Resources\n| where old\n| project id', 'Resources\n| where new\n| project id')).toEqual([
      { kind: 'same', text: 'Resources' },
      { kind: 'removed', text: '| where old' },
      { kind: 'added', text: '| where new' },
      { kind: 'same', text: '| project id' },
    ]);
    expect(diffQueryLines('A\nB\nA', 'A\nA\nC')).toEqual([
      { kind: 'same', text: 'A' }, { kind: 'removed', text: 'B' },
      { kind: 'same', text: 'A' }, { kind: 'added', text: 'C' },
    ]);
    expect(diffQueryLines('', 'A')).toEqual([{ kind: 'added', text: 'A' }]);
    expect(diffQueryLines('A', '')).toEqual([{ kind: 'removed', text: 'A' }]);
    expect(diffQueryLines('', '')).toEqual([]);
    expect(diffQueryLines('A\r\nB', 'A\nB')).toEqual([{ kind: 'same', text: 'A' }, { kind: 'same', text: 'B' }]);
    expect(diffQueryLines('A\n', 'A')).toEqual([{ kind: 'same', text: 'A' }, { kind: 'removed', text: '' }]);
  });

  it('labels Before versioning and upstream dates, with optional UTC time for selector entries on the same day', () => {
    expect(versionLabel('before-versioning')).toBe('Before versioning');
    expect(versionLabel('1.2.0')).toBe('1.2.0');
    expect(versionLabel('2026-06-08T13:06:47Z')).toBe('2026-06-08');
    const versions = [{ version: '2026-06-08T13:06:47Z' }, { version: '2026-06-08T16:06:47Z' }];
    expect(versionLabel(versions[0].version, true)).toBe('2026-06-08 13:06:47 UTC');
    expect(versionLabel(versions[1].version, true)).toBe('2026-06-08 16:06:47 UTC');
  });

  it('reviews every changed definition field, including cleared values, and excludes unchanged fields', () => {
    const before: RuleVersionDefinition = shippedRule().definition;
    const after: RuleVersionDefinition = {
      ...before, name: 'New name', description: 'New recommendation.', category: 'compliance',
      severity: 'high', queryBackend: 'log-analytics', kind: 'activity', resourceTypes: [],
      scope: { level: 'subscription' }, conditions: [{ field: 'name', operator: 'equals', value: 'test' }],
      conditionGroups: [{ id: 'group', conditions: [] }], visualQuery: { stages: [] },
      projectColumns: ['id'], rawKql: null, graphQuery: { path: 'users' },
      logsQuery: { kql: 'AzureActivity | project id', timeWindowDays: 7, dimensionKeyField: 'id' },
    };
    expect(changedFields(before, after)).toEqual([
      'name', 'description', 'category', 'severity', 'queryBackend', 'kind', 'resourceTypes',
      'scope', 'conditions', 'conditionGroups', 'visualQuery', 'projectColumns', 'rawKql', 'graphQuery', 'logsQuery',
    ]);
    expect(changedFields(before, { ...before })).toEqual([]);
    expect(changedFields(after, { ...after, graphQuery: null })).toEqual(['graphQuery']);
  });
});
