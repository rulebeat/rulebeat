/**
 * ADR 0008: the address of a snapshot. `?scan=` keeps the meaning it always had, so a link made before
 * the snapshot moved to the server opens the same run; the filters, search and page are written by one
 * function and read by another, so the server page and the screen never disagree; and no parameter of the
 * snapshot is one the findings explorer on the same page reads.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { emptyView, viewFromSearchParams, viewToSearchParams, type View } from '@/lib/finding-view';
import {
  SNAPSHOT_PARAMS, emptySnapshotQuery, snapshotQueryFromParams, snapshotQueryToParams, type SnapshotQuery,
} from '@/lib/snapshot-query';

const BASE = new URLSearchParams('tab=history&run=run-1&scan=scan-1');
const query = (over: Partial<SnapshotQuery> = {}): SnapshotQuery => ({ ...emptySnapshotQuery(), ...over });

describe('an existing ?scan= link', () => {
  it('asks for the whole run, first page, as it always did', () => {
    expect(snapshotQueryFromParams(new URLSearchParams('tab=history&run=run-1&scan=scan-1'))).toEqual(emptySnapshotQuery());
  });

  it('is left exactly as it was when the snapshot has nothing to add', () => {
    expect(snapshotQueryToParams(emptySnapshotQuery(), BASE).toString()).toBe(BASE.toString());
  });

  it('keeps the page\'s own parameters, first and untouched, when the snapshot writes its own', () => {
    const written = snapshotQueryToParams(query({ severity: ['high'], search: 'vm', page: 2 }), BASE).toString();
    expect(written.startsWith(`${BASE.toString()}&`)).toBe(true);
    const params = new URLSearchParams(written);
    expect([params.get('tab'), params.get('run'), params.get('scan')]).toEqual(['history', 'run-1', 'scan-1']);
  });
});

describe('what the screen writes and the server page reads', () => {
  const QUERIES: SnapshotQuery[] = [
    query(),
    query({ severity: ['critical', 'low'] }),
    query({ rule: ['rule-1', 'rule-2'] }),
    query({ search: 'vm one & two=3' }),
    query({ search: '100% /subscriptions/a b' }),
    query({ page: 7 }),
    query({ severity: ['high'], rule: ['rule-1'], search: 'storage', page: 3 }),
  ];

  it.each(QUERIES.map(q => [JSON.stringify(q), q] as const))('give the same query back through the address: %s', (_name, q) => {
    const written = snapshotQueryToParams(q, BASE);
    // The page reads a record of strings; the browser reads URLSearchParams. Both agree.
    const asRecord: Record<string, string | string[]> = {};
    for (const key of new Set(written.keys())) asRecord[key] = written.getAll(key).length > 1 ? written.getAll(key) : written.get(key)!;
    expect(snapshotQueryFromParams(asRecord)).toEqual(q);
    expect(snapshotQueryFromParams(new URLSearchParams(written.toString()))).toEqual(q);
  });

  it('reads one query for one choice, whatever order the severities were written in, so a link opens one view', () => {
    const lowFirst = new URLSearchParams('snapSeverity=low&snapSeverity=critical');
    const criticalFirst = new URLSearchParams('snapSeverity=critical&snapSeverity=low');
    expect(snapshotQueryFromParams(lowFirst)).toEqual(snapshotQueryFromParams(criticalFirst));
    expect(snapshotQueryFromParams(lowFirst).severity).toEqual(['critical', 'low']);
  });

  it('writes again over its own parameters instead of adding to them', () => {
    const once = snapshotQueryToParams(query({ severity: ['high'], page: 2 }), BASE);
    const again = snapshotQueryToParams(query({ rule: ['rule-1'] }), once);
    expect(again.has(SNAPSHOT_PARAMS.severity)).toBe(false);
    expect(again.has(SNAPSHOT_PARAMS.page)).toBe(false);
    expect(again.getAll(SNAPSHOT_PARAMS.rule)).toEqual(['rule-1']);
  });

  it('ignores a malformed address rather than refusing it', () => {
    const read = snapshotQueryFromParams(new URLSearchParams('snapSeverity=bogus&snapSeverity=high&snapPage=-4&snapRule='));
    expect(read).toEqual(query({ severity: ['high'] }));
    expect(snapshotQueryFromParams(new URLSearchParams('snapPage=9999999999')).page).toBe(1);
  });
});

describe('the snapshot and the explorer on one page', () => {
  const explorerView: View = {
    ...emptyView(),
    filters: [{ field: 'severity', values: ['low'] }, { field: 'rule', values: ['explorer-rule'] }],
    search: 'explorer text',
    page: 5,
  };

  it('share no parameter name', () => {
    const explorerNames = new Set(viewToSearchParams({
      ...explorerView,
      filters: [...explorerView.filters, { field: 'status', values: ['all'] }, { field: 'category', values: ['c'] }, { field: 'tags', values: ['t'] }],
      columns: ['a'], sort: { field: 'severity', dir: 'desc' }, groupBy: ['rule'], window: { mode: 'relative', days: 30 },
    }, { view: 'saved-1' }).keys());
    for (const name of Object.values(SNAPSHOT_PARAMS)) expect(explorerNames.has(name)).toBe(false);
  });

  it('are not read as each other\'s', () => {
    const snapshot = snapshotQueryToParams(query({ severity: ['high'], rule: ['rule-1'], search: 'vm', page: 3 }), BASE);
    expect(viewFromSearchParams(snapshot)).toEqual(emptyView());
    const both = viewToSearchParams(explorerView, snapshot);
    expect(snapshotQueryFromParams(both)).toEqual(query({ severity: ['high'], rule: ['rule-1'], search: 'vm', page: 3 }));
    expect(snapshotQueryFromParams(viewToSearchParams(explorerView, BASE))).toEqual(emptySnapshotQuery());
  });
});

describe('the server page', () => {
  const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', '(app)', 'scans', 'page.tsx'), 'utf8');

  it('passes the scan id through and reads the snapshot\'s query with the one reader, without loading the scan', () => {
    expect(page).toContain('snapshotQueryFromParams(params)');
    expect(page).toMatch(/snapshotScanId\s*=\s*scanId/);
    // `getScanById` stays for the compare screen, which still loads both scans; the one `?scan=` names is not.
    expect(page).not.toMatch(/getScanById\(\s*scanId\s*\)/);
  });
});
