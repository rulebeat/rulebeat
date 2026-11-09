/**
 * The notice a person reads when their save met a newer revision (ADR 0013): who changed the saved
 * filters, when, and which dimensions moved under them without their touching them.
 */
import { describe, expect, it } from 'vitest';
import { buildBarState } from '@/lib/dashboard-bar';
import { conflictNotice, movedDimensions, timeLabel } from '@/lib/dashboard-conflict';
import type { DashboardFilters } from '@/lib/finding-view';
import { EVERYTHING_ACCESS } from '../helpers/access';

const SAVED: DashboardFilters = {
  category: [], subscription: [], resourceGroup: [], tags: [], rule: [], severity: ['critical'],
  window: { mode: 'relative', days: 30 },
};
const barOf = (saved: DashboardFilters, changes = {}) => buildBarState({ revision: 1, saved, changes, access: EVERYTHING_ACCESS, widgets: [] }).state;
const at = '2026-11-09T10:30:00.000Z';
const time = () => '10:30';

describe('the conflict notice', () => {
  it('names who changed the saved filters and when, and says the changes are still in the address', () => {
    expect(conflictNotice({ by: 'Sam Rivera', at, moved: [], formatTime: time })).toBe(
      "Sam Rivera changed this dashboard's saved filters at 10:30. Your changes are still in the address. Check them, then save again.",
    );
  });

  it('names the dimensions that moved without the person changing them', () => {
    expect(conflictNotice({ by: 'sam@example.com', at, moved: ['Severity', 'Date window'], formatTime: time })).toBe(
      "sam@example.com changed this dashboard's saved filters at 10:30. This also changed Severity and Date window for you. Your changes are still in the address. Check them, then save again.",
    );
  });

  it('says the open layout edit is why the new layout is not shown, when one is open', () => {
    expect(conflictNotice({ by: 'Sam Rivera', at, moved: [], formatTime: time, layoutEditOpen: true })).toBe(
      "Sam Rivera changed this dashboard's saved filters at 10:30. Your changes are still in the address. Check them, then save again. Your layout edit is still open: save or cancel it to load the new layout.",
    );
  });

  it('puts a date on a time that is not today', () => {
    const now = new Date('2026-11-09T12:00:00.000Z');
    expect(timeLabel('2026-11-09T10:30:00.000Z', now)).not.toMatch(/2026|Nov/);
    expect(timeLabel('2026-11-07T10:30:00.000Z', now)).toMatch(/Nov/);
  });

  it('does not claim a name or time it was not given', () => {
    expect(conflictNotice({ moved: [], formatTime: time })).toBe(
      "This dashboard's saved filters changed since you opened it. Your changes are still in the address. Check them, then save again.",
    );
  });
});

describe('the dimensions that moved under the person', () => {
  it('names a dimension whose saved value changed and that the person did not touch', () => {
    const before = barOf(SAVED);
    const after = barOf({ ...SAVED, severity: ['high'], window: { mode: 'relative', days: 7 } });
    expect(movedDimensions(before, after, {})).toEqual(['Severity', 'Date window']);
  });

  it('leaves out a dimension the person changed, because their value still wins', () => {
    const changes = { severity: ['low'] };
    const before = barOf(SAVED, changes);
    const after = barOf({ ...SAVED, severity: ['high'], tags: ['a'] }, changes);
    expect(movedDimensions(before, after, changes)).toEqual(['Tags']);
  });

  it('names nothing when the effective values are the same', () => {
    expect(movedDimensions(barOf(SAVED), barOf(SAVED), {})).toEqual([]);
  });
});
