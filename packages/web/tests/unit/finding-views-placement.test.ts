/**
 * #447: Scans can filter, group and show findings by where they sit ("Placed at"). Driven through the
 * server's own reads (`queryView`, `queryGroup`) over findings stored by a scan, one at each placement,
 * so it runs on whichever backend tests/setup.ts selected. The value is the placement key; what a person
 * reads in a facet or a group header is the label.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { resetDb } from '../helpers/db';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';
import { emptyView, type View, type ViewFilter } from '@/lib/finding-view';
import { queryGroup, queryView } from '@/lib/db/finding-views';
import type { ViewTab } from '@/lib/view-response';
import { EVERYTHING_ACCESS } from '../helpers/access';

const RULE = 'placement-rule';

beforeAll(async () => {
  await resetDb();
  await storeScan([
    syntheticFinding('vm-a', [{ n: 1 }], { ruleId: RULE, subscriptionId: '11111111-1111-1111-1111-111111111111' }),
    syntheticFinding('vm-b', [{ n: 2 }], { ruleId: RULE, subscriptionId: '22222222-2222-2222-2222-222222222222' }),
    syntheticFinding('sub-level', [{ n: 3 }], { ruleId: RULE, placement: 'subscription' }),
    syntheticFinding('mg-level', [{ n: 4 }], { ruleId: RULE, placement: 'management-group' }),
    syntheticFinding('app-1', [{ n: 5 }], { ruleId: RULE, placement: 'directory' }),
    syntheticFinding('thing', [{ n: 6 }], { ruleId: RULE, placement: 'unplaceable' }),
    syntheticFinding('law-user', [{ n: 7 }], { ruleId: RULE, placement: 'workspace' }),
  ], { scanId: 'placement-scan', finishedAt: new Date().toISOString() });
});

const withPlacement = (...values: string[]): View => ({ ...emptyView(), filters: [{ field: 'placement', values } as ViewFilter] });
const query = (tab: ViewTab) => ({ tab, showSuppressed: false });
const names = (response: Awaited<ReturnType<typeof queryView>>) => response.items.map(i => i.finding.resourceName).sort();

describe('a placement filter narrows the Results list on the server', () => {
  it('lists only the findings at the placement', async () => {
    expect(names(await queryView(withPlacement('resource'), query('results'), EVERYTHING_ACCESS))).toEqual(['vm-a', 'vm-b']);
    expect(names(await queryView(withPlacement('management-group'), query('results'), EVERYTHING_ACCESS))).toEqual(['mg-level']);
  });

  it('lists the union of several placements', async () => {
    expect(names(await queryView(withPlacement('directory', 'unplaceable'), query('results'), EVERYTHING_ACCESS))).toEqual(['app-1', 'thing']);
  });

  it('keeps every finding when no placement is chosen', async () => {
    expect((await queryView(emptyView(), query('results'), EVERYTHING_ACCESS)).tiles.total).toBe(6);
  });
});

describe('a placement is shown by its label, never its key', () => {
  it('labels the facet options and counts each', async () => {
    const { facets } = await queryView(withPlacement('resource'), query('results'), EVERYTHING_ACCESS);
    expect(facets.placement).toEqual([
      { value: 'directory', label: 'Directory', count: 1 },
      { value: 'management-group', label: 'Management group', count: 1 },
      { value: 'unplaceable', label: 'Not placed', count: 1 },
      { value: 'resource', label: 'Resource', count: 2 },
      { value: 'subscription', label: 'Subscription', count: 1 },
    ]);
  });

  it('labels the group headers, and opens a group to its findings', async () => {
    const view: View = { ...emptyView(), groupBy: ['placement'] };
    const response = await queryView(view, query('results'), EVERYTHING_ACCESS);
    expect(response.grouped?.groups.map(g => [g.value, g.label, g.findingCount])).toEqual([
      ['directory', 'Directory', 1],
      ['management-group', 'Management group', 1],
      ['unplaceable', 'Not placed', 1],
      ['resource', 'Resource', 2],
      ['subscription', 'Subscription', 1],
    ]);
    const opened = await queryGroup(view, { ...query('results'), groupPath: ['resource'], groupPage: 1 }, EVERYTHING_ACCESS);
    expect(opened.items.map(i => i.finding.resourceName).sort()).toEqual(['vm-a', 'vm-b']);
  });
});
