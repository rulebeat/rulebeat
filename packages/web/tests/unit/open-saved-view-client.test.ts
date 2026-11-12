/**
 * What the Scans page does with an open saved view (#373, ADR 0012): the reads carry `view=<id>`, a saved view held
 * back in full says so and is closed only by the viewer, and a view that no longer opens is announced once and dropped.
 */
import { describe, expect, it } from 'vitest';
import { emptyView, viewToSearchParams, type View, type ViewFilter } from '@/lib/finding-view';
import {
  OPEN_VIEW_OUTSIDE_COPY, OUTSIDE_ACCESS_LABEL, SAVED_VIEW_GONE_COPY, dimensionsHeldInFull, withoutHeldPlaceholders, type HeldBack,
} from '@/lib/held-back';
import { columnValuesUrl, exportUrl, groupUrl, rowsUrl, ruleFindingsUrl, viewQuery, viewUrl, type ViewRequest } from '@/lib/explorer-session';
import { rowField } from '@/lib/finding-view';
import { savedViewHref } from '@/lib/saved-view-query';

const SUB_ONE = '00000000-0000-0000-0000-00000000000a';
const filters = (...list: ViewFilter[]): View => ({ ...emptyView(), filters: list });
const request = (view: View, savedViewId?: string | null): ViewRequest => ({ view, tab: 'advisories', showSuppressed: false, savedViewId });
const held = (dimension: string, count = 1): HeldBack => ({ place: 'savedView', id: 'v1', dimension, count });

describe('the reads of an open saved view', () => {
  const open = request(filters({ field: 'severity', values: ['high'] }), 'view-1');
  const viewParam = (url: string) => new URL(`http://x${url}`).searchParams.get('view');

  it('name the view in the view read and in every other read and the export', () => {
    for (const url of [
      viewUrl(open), rowsUrl(open, 'fp', 1), groupUrl(open, ['a'], 1), columnValuesUrl(open, rowField('zone'), ''),
      ruleFindingsUrl(open, 'rule-1', 1), exportUrl(open, 'csv'),
    ]) expect(viewParam(url), url).toBe('view-1');
  });

  it('name no view when none is open, or when it was dropped', () => {
    expect(viewQuery(request(emptyView()))).toBe('tab=advisories');
    expect(viewQuery(request(emptyView(), null))).toBe('tab=advisories');
  });

  it('read as a different query once the view is dropped, so the list is read again', () => {
    expect(viewQuery(open)).not.toBe(viewQuery({ ...open, savedViewId: null }));
  });
});

describe('a dimension a saved view holds back in full', () => {
  const query = (...list: ViewFilter[]) => viewToSearchParams(filters(...list)).toString();

  it('is the one that opened holding only the placeholder', () => {
    const q = query({ field: 'subscription', values: [OUTSIDE_ACCESS_LABEL] }, { field: 'resourceName', values: ['vm-one'] });
    expect(dimensionsHeldInFull(q, [held('subscription'), held('resourceName')])).toEqual(['subscription']);
  });

  it('is not one where something of the view is visible, nor one nothing is held back from', () => {
    expect(dimensionsHeldInFull(query({ field: 'subscription', values: [SUB_ONE] }), [held('subscription')])).toEqual([]);
    expect(dimensionsHeldInFull(query({ field: 'subscription', values: [OUTSIDE_ACCESS_LABEL] }), [])).toEqual([]);
  });

  it('has copy that says to close the view', () => {
    expect(OPEN_VIEW_OUTSIDE_COPY).toBe('This saved view is filtered to places outside your Access. Close the view to see your own findings.');
    expect(SAVED_VIEW_GONE_COPY).toBe('This saved view no longer exists.');
  });

  it('is the placeholder the filters lose when the view is closed, which is the only way to widen', () => {
    const list: ViewFilter[] = [
      { field: 'subscription', values: [OUTSIDE_ACCESS_LABEL] },
      { field: 'resourceName', values: [OUTSIDE_ACCESS_LABEL, 'vm-one'] },
      { field: 'severity', values: ['high'] },
    ];
    expect(withoutHeldPlaceholders(list)).toEqual([
      { field: 'resourceName', values: ['vm-one'] },
      { field: 'severity', values: ['high'] },
    ]);
  });

  it('keeps a value called the same in a dimension that is not held back', () => {
    const list: ViewFilter[] = [{ field: 'rule', values: [OUTSIDE_ACCESS_LABEL] }];
    expect(withoutHeldPlaceholders(list)).toEqual(list);
  });
});

describe('opening a saved view', () => {
  it('puts the view\'s id next to the values the viewer can see', () => {
    const href = savedViewHref({ id: 'v1', tab: 'results', query: viewToSearchParams(filters({ field: 'subscription', values: [OUTSIDE_ACCESS_LABEL, SUB_ONE] })).toString() });
    const params = new URL(`http://x${href}`).searchParams;
    expect(params.get('view')).toBe('v1');
    expect(params.get('subscription')).toBe(`${OUTSIDE_ACCESS_LABEL},${SUB_ONE}`);
  });
});
