/**
 * Spec 037 — buildRuleFromQuery() is the payload the /query page's "Save as rule" button hands
 * to /rules/new via sessionStorage (query-client.tsx's saveAsRule() -> rule-new-client.tsx's
 * readQueryPrefill()). Pulled out of the component specifically so each backend's shape is
 * testable without rendering React — this codebase has no @testing-library/RTL convention
 * (grepped, zero hits), so a rendered-component test isn't the idiomatic path here.
 */
import { describe, expect, it } from 'vitest';
import { buildRuleFromQuery } from '@/lib/query-to-rule';
import { defaultVisualQuery } from '@/components/rules/visual-query-builder';

describe('buildRuleFromQuery (spec 037)', () => {
  describe('base fields, shared across every backend', () => {
    it('starts blank, disabled, and custom-typed, regardless of backend', () => {
      const rule = buildRuleFromQuery({ backend: 'microsoft-graph', defaultCategoryId: 'security', graphQuery: { path: 'users' } });
      expect(rule.id).toBe('');
      expect(rule.name).toBe('');
      expect(rule.description).toBe('');
      expect(rule.severity).toBe('medium');
      expect(rule.enabled).toBe(false);
      expect(rule.type).toBe('custom');
      expect(rule.conditions).toEqual([]);
    });

    it('uses the page default category when one is available', () => {
      const rule = buildRuleFromQuery({ backend: 'microsoft-graph', defaultCategoryId: 'security', graphQuery: { path: 'users' } });
      expect(rule.category).toBe('security');
    });

    it('falls back to "compliance" when no category exists yet (defaultCategoryId is empty)', () => {
      const rule = buildRuleFromQuery({ backend: 'microsoft-graph', defaultCategoryId: '', graphQuery: { path: 'users' } });
      expect(rule.category).toBe('compliance');
    });
  });

  describe('resource-graph backend', () => {
    it('carries the scope, visual query, raw KQL, and parses resource types / project columns from CSV', () => {
      const visualQuery = defaultVisualQuery();
      const rule = buildRuleFromQuery({
        backend: 'resource-graph',
        defaultCategoryId: 'compliance',
        scope: { level: 'subscription', subscriptions: ['sub-1'] },
        resourceTypesText: ' Microsoft.Compute/virtualMachines , Microsoft.Storage/storageAccounts ',
        projectColumnsText: 'name, resourceGroup,,location',
        visualQuery,
        rawKql: 'resources | where type =~ "microsoft.compute/virtualmachines"',
      });

      expect(rule.queryBackend).toBe('resource-graph');
      expect(rule.scope).toEqual({ level: 'subscription', subscriptions: ['sub-1'] });
      expect(rule.resourceTypes).toEqual(['Microsoft.Compute/virtualMachines', 'Microsoft.Storage/storageAccounts']);
      expect(rule.projectColumns).toEqual(['name', 'resourceGroup', 'location']);
      expect(rule.visualQuery).toEqual(visualQuery);
      expect(rule.rawKql).toBe('resources | where type =~ "microsoft.compute/virtualmachines"');
      expect(rule.graphQuery).toBeUndefined();
      expect(rule.logsQuery).toBeUndefined();
    });

    it('falls back to a resource-level scope when no scope was resolved yet', () => {
      const rule = buildRuleFromQuery({
        backend: 'resource-graph',
        defaultCategoryId: 'compliance',
        scope: undefined,
        resourceTypesText: '*',
        projectColumnsText: '',
        visualQuery: defaultVisualQuery(),
        rawKql: 'resources',
      });
      expect(rule.scope).toEqual({ level: 'resource' });
    });

    it('produces an empty resourceTypes/projectColumns array from blank CSV text, not [""]', () => {
      const rule = buildRuleFromQuery({
        backend: 'resource-graph',
        defaultCategoryId: 'compliance',
        scope: { level: 'resource' },
        resourceTypesText: '',
        projectColumnsText: '',
        visualQuery: defaultVisualQuery(),
        rawKql: 'resources',
      });
      expect(rule.resourceTypes).toEqual([]);
      expect(rule.projectColumns).toEqual([]);
    });
  });

  describe('microsoft-graph backend', () => {
    it('forces a subscription-level scope and carries the graph query, leaving ARG/Logs fields unset', () => {
      const rule = buildRuleFromQuery({
        backend: 'microsoft-graph',
        defaultCategoryId: 'identity',
        graphQuery: { path: 'users', filter: 'accountEnabled eq true' },
      });

      expect(rule.queryBackend).toBe('microsoft-graph');
      expect(rule.scope).toEqual({ level: 'subscription' });
      expect(rule.graphQuery).toEqual({ path: 'users', filter: 'accountEnabled eq true' });
      expect(rule.rawKql).toBeUndefined();
      expect(rule.visualQuery).toBeUndefined();
      expect(rule.logsQuery).toBeUndefined();
      expect(rule.resourceTypes).toEqual([]);
    });
  });

  describe('log-analytics backend', () => {
    it('forces a subscription-level scope and a 30-day window not collected on the query page', () => {
      const rule = buildRuleFromQuery({
        backend: 'log-analytics',
        defaultCategoryId: 'reliability',
        logsKql: 'SigninLogs | where ResultType != 0',
      });

      expect(rule.queryBackend).toBe('log-analytics');
      expect(rule.scope).toEqual({ level: 'subscription' });
      expect(rule.logsQuery).toEqual({ kql: 'SigninLogs | where ResultType != 0', timeWindowDays: 30 });
      expect(rule.graphQuery).toBeUndefined();
      expect(rule.rawKql).toBeUndefined();
    });
  });

  describe('sessionStorage round trip', () => {
    // saveAsRule() hands this object to JSON.stringify() for sessionStorage, and
    // readQueryPrefill() JSON.parses it straight back into a Rule — a value that mutates
    // under that round trip would silently corrupt the prefill.
    it('is unchanged by JSON.stringify -> JSON.parse for every backend', () => {
      const rules = [
        buildRuleFromQuery({
          backend: 'resource-graph', defaultCategoryId: 'compliance',
          scope: { level: 'managementGroup', managementGroups: ['mg-1'] },
          resourceTypesText: '*', projectColumnsText: 'name, id',
          visualQuery: defaultVisualQuery(), rawKql: 'resources',
        }),
        buildRuleFromQuery({ backend: 'microsoft-graph', defaultCategoryId: 'identity', graphQuery: { path: 'groups' } }),
        buildRuleFromQuery({ backend: 'log-analytics', defaultCategoryId: 'reliability', logsKql: 'Heartbeat | take 10' }),
      ];
      for (const rule of rules) {
        expect(JSON.parse(JSON.stringify(rule))).toEqual(rule);
      }
    });
  });
});
