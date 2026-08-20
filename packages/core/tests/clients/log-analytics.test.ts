import { describe, expect, it } from 'vitest';
import type { LogsTable } from '@azure/monitor-query-logs';
import {
  rowsFromLogsTable,
  LogAnalyticsTruncatedError,
  LogAnalyticsNotConfiguredError,
} from '../../src/clients/log-analytics.js';

/**
 * `rowsFromLogsTable()` is the pure, SDK-independent half of the Log Analytics client (spec 035) —
 * the network call around it (`queryLogAnalyticsWorkspace()`) is deliberately not unit tested here,
 * same precedent as `verifyAzureCredential()`: a function whose whole job is a live Azure call gets
 * its coverage from ctx-based fakes at the call sites, not a mocked SDK.
 */

function table(columns: Array<{ name: string; type?: string }>, rows: LogsTable['rows']): LogsTable {
  return {
    name: 'PrimaryResult',
    columnDescriptors: columns.map(c => ({ name: c.name, type: (c.type ?? 'string') as never })),
    rows,
  };
}

describe('rowsFromLogsTable', () => {
  it('zips columnDescriptors and positional rows into named records', () => {
    const t = table(
      [{ name: 'ResourceId' }, { name: 'Count', type: 'long' }],
      [['/subscriptions/x/resourceGroups/y/providers/z', 3]],
    );
    expect(rowsFromLogsTable(t)).toEqual([{ ResourceId: '/subscriptions/x/resourceGroups/y/providers/z', Count: 3 }]);
  });

  it('preserves row order and produces one record per row', () => {
    const t = table(
      [{ name: 'TimeGenerated', type: 'datetime' }, { name: 'Level' }],
      [
        ['2026-08-19T00:00:00Z', 'Error'],
        ['2026-08-19T01:00:00Z', 'Warning'],
        ['2026-08-19T02:00:00Z', 'Info'],
      ],
    );
    expect(rowsFromLogsTable(t).map(r => (r as { Level: string }).Level)).toEqual(['Error', 'Warning', 'Info']);
  });

  it('returns an empty array for a table with no rows', () => {
    const t = table([{ name: 'Col' }], []);
    expect(rowsFromLogsTable(t)).toEqual([]);
  });

  it('keys by column name, independent of a column being renamed via KQL project', () => {
    const t = table([{ name: 'id' }, { name: 'friendlyName' }], [['abc-123', 'My Resource']]);
    const [row] = rowsFromLogsTable<{ id: string; friendlyName: string }>(t);
    expect(row).toEqual({ id: 'abc-123', friendlyName: 'My Resource' });
  });

  it('passes non-primitive cell values (dynamic columns) through unchanged', () => {
    const tags = { env: 'prod', team: 'platform' };
    const t = table([{ name: 'Tags', type: 'dynamic' }], [[tags]]);
    const [row] = rowsFromLogsTable<{ Tags: Record<string, unknown> }>(t);
    expect(row.Tags).toBe(tags);
  });

  it('does not let one row leak fields into the next', () => {
    const t = table(
      [{ name: 'A' }, { name: 'B' }],
      [['a1', 'b1'], ['a2', 'b2']],
    );
    const [first, second] = rowsFromLogsTable(t);
    expect(first).toEqual({ A: 'a1', B: 'b1' });
    expect(second).toEqual({ A: 'a2', B: 'b2' });
  });
});

describe('LogAnalyticsTruncatedError', () => {
  it('names the error and reports how many rows were seen before the partial failure', () => {
    const err = new LogAnalyticsTruncatedError(42);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LogAnalyticsTruncatedError');
    expect(err.rowsSeen).toBe(42);
    expect(err.message).toContain('42');
  });
});

describe('LogAnalyticsNotConfiguredError', () => {
  it('names the error and points at both ways to configure a workspace', () => {
    const err = new LogAnalyticsNotConfiguredError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LogAnalyticsNotConfiguredError');
    expect(err.message).toContain('Settings');
    expect(err.message).toContain('RULEBEAT_LOG_ANALYTICS_WORKSPACE_ID');
  });
});
