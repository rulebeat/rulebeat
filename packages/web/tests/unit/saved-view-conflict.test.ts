/**
 * What a person reads about a saved view when their save met a newer revision (ADR 0013), and which parts of
 * the view are marked Changed beside "Update with current view". Both compare Views part by part.
 */
import { describe, expect, it } from 'vitest';
import { SAVED_VIEW_RELOADED_NOTICE, changedMark, differingParts, droppedNotice, movedParts } from '@/lib/saved-view-conflict';
import { conflictNotice } from '@/lib/dashboard-conflict';
import { savedViewAddress, viewFromSearchParams, type View } from '@/lib/finding-view';

const viewOf = (query: string): View => viewFromSearchParams(new URLSearchParams(query));
const SAVED = viewOf('severity=critical&subscription=sub-a&q=vm&window=30&cols=zone&sort=rule%3Adesc&group=category&gsort=count%3Adesc&rf=zone%3Da');

describe('the parts of a view that differ', () => {
  it('is empty for a view that is the saved view', () => {
    expect(differingParts(SAVED, SAVED)).toEqual([]);
  });

  it('names each part by the label the explorer shows, in the order the explorer lists them', () => {
    const current: View = {
      ...viewOf('severity=low&subscription=sub-b&q=disk&window=7&cols=sku&sort=severity%3Aasc&group=rule&gsort=value%3Aasc&rf=zone%3Db'),
    };
    expect(differingParts(SAVED, current)).toEqual([
      'Severity', 'Subscription', 'zone (returned)', 'Search', 'Date window', 'Columns', 'Sort', 'Grouping', 'Group order',
    ]);
  });

  it('compares a value list as a set and ignores the page', () => {
    const saved = viewOf('subscription=a%2Cb');
    expect(differingParts(saved, { ...viewOf('subscription=b%2Ca'), page: 4 })).toEqual([]);
  });

  it('names a filter that was added or removed', () => {
    expect(differingParts(viewOf(''), viewOf('severity=low'))).toEqual(['Severity']);
    expect(differingParts(viewOf('severity=low'), viewOf(''))).toEqual(['Severity']);
  });
});

describe('the parts that moved under the person', () => {
  const changes = new URLSearchParams('severity=low');

  it('names a part the newer revision changed and the person did not touch', () => {
    const newer = viewOf('severity=critical&subscription=sub-a&q=disk&window=30');
    const older = viewOf('severity=critical&subscription=sub-a&q=vm&window=30');
    expect(movedParts(older, newer, changes)).toEqual(['Search']);
  });

  it('leaves out a part the person changed, because their value still wins', () => {
    const older = viewOf('severity=critical');
    const newer = viewOf('severity=high');
    expect(movedParts(older, newer, changes)).toEqual([]);
  });

  it('reads the changes with the same address the page writes, so Any counts as a change', () => {
    const older = viewOf('severity=critical&q=vm');
    const newer = viewOf('severity=high&q=disk');
    const any = savedViewAddress(older).write({ ...older, search: '' });
    expect(movedParts(older, newer, any)).toEqual(['Severity']);
  });
});

describe('the notice for a saved view', () => {
  it('says saved view, and who changed it and when', () => {
    expect(conflictNotice({ subject: 'saved view', by: 'Sam Rivera', at: '2026-11-09T10:30:00.000Z', moved: ['Search'], formatTime: () => '10:30' })).toBe(
      'Sam Rivera changed this saved view at 10:30. This also changed Search for you. Your changes are still in the address. Check them, then save again.',
    );
  });

  it('does not claim a name or time it was not given', () => {
    expect(conflictNotice({ subject: 'saved view', moved: [] })).toBe(
      'This saved view changed since you opened it. Your changes are still in the address. Check them, then save again.',
    );
  });
});

describe('the Changed mark beside Update with current view', () => {
  it('lists the parts that differ, and is absent when none does', () => {
    expect(changedMark(['Severity', 'Search'])).toBe('Changed: Severity, Search');
    expect(changedMark([])).toBeNull();
  });
});

describe('what the save dialog says about values outside the person\'s access', () => {
  it('counts them, in the singular and the plural', () => {
    expect(droppedNotice(1)).toBe('1 value outside your access was not saved.');
    expect(droppedNotice(3)).toBe('3 values outside your access were not saved.');
  });
});

describe('the notice for a change picked up on a read', () => {
  it('says the view and the numbers were reloaded and that the changes are still in the address', () => {
    expect(SAVED_VIEW_RELOADED_NOTICE).toBe(
      'This saved view changed since you opened it. The filters and every number were reloaded. Your changes are still in the address.',
    );
  });
});
