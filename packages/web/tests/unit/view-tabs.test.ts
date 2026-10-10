/**
 * #183: each kind is listed on exactly one Scans tab, and a tab whose findings never resolve offers
 * no "Fixed" status.
 */
import { describe, expect, it } from 'vitest';
import { parseViewTab, TAB_KINDS, tabForKind, tabResolves, tabStatusOptions, VIEW_TABS } from '@/lib/view-response';
import type { RuleKind } from '@/lib/types';

const KINDS: RuleKind[] = ['state', 'advisory', 'activity'];

describe('the Scans tabs', () => {
  it('lists every kind on exactly one tab', () => {
    for (const kind of KINDS) {
      expect(VIEW_TABS.filter(tab => TAB_KINDS[tab].includes(kind))).toEqual([tabForKind(kind)]);
    }
  });

  it('links a Problem to Results, an Advisory to Advisories and an Activity finding to Activity', () => {
    expect([tabForKind('state'), tabForKind(undefined), tabForKind('advisory'), tabForKind('activity')])
      .toEqual(['results', 'results', 'advisories', 'activity']);
  });

  it('reads the activity tab from a URL value, and nothing it does not know', () => {
    expect(parseViewTab('activity')).toBe('activity');
    expect(parseViewTab('history')).toBeNull();
  });

  it('offers "Fixed" only on a tab whose findings resolve', () => {
    expect([tabResolves('results'), tabResolves('advisories'), tabResolves('activity')]).toEqual([true, true, false]);
    expect(tabStatusOptions('activity', '7d').map(o => o.value)).toEqual(['open', 'new', 'all']);
    expect(tabStatusOptions('results', '7d').map(o => o.label)).toEqual(['Open', 'New (7d)', 'Fixed (7d)', 'All']);
  });
});
