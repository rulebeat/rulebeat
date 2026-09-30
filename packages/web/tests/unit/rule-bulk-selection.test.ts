/**
 * The Rules tab's bulk selection is state in scans-client.tsx driven entirely by these functions.
 * This codebase has no React component-rendering test layer (Vitest runs `environment: 'node'`, no
 * @testing-library/react), so the selection contract, that a bulk action only ever reaches rules
 * the current filters show and only sends the ones it would change, is verified here.
 */
import { describe, expect, it } from 'vitest';
import {
  bulkChanges, bulkRequestBody, headerCheckboxState, pruneSelection, toggleAllVisible,
} from '@/lib/rule-bulk-selection';
import { toggleInSet } from '@/lib/toggle-set';

const rule = (id: string, enabled: boolean) => ({ id, enabled });

const all = [rule('a', true), rule('b', false), rule('c', true), rule('d', false), rule('e', true)];
// What a filter such as "severity: high" might leave on screen.
const filtered = [all[0], all[1], all[2]];

describe('header checkbox', () => {
  it('selects every visible rule and none the filters hide', () => {
    expect(toggleAllVisible(new Set(), filtered)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('selects the rest when only some visible rules are selected', () => {
    expect(toggleAllVisible(new Set(['a']), filtered)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('clears the selection when every visible rule is already selected', () => {
    expect(toggleAllVisible(new Set(['a', 'b', 'c']), filtered)).toEqual(new Set());
  });

  it('reads all, some or none of the visible rules', () => {
    expect(headerCheckboxState(new Set(), filtered)).toBe('none');
    expect(headerCheckboxState(new Set(['b']), filtered)).toBe('some');
    expect(headerCheckboxState(new Set(['a', 'b', 'c']), filtered)).toBe('all');
  });

  it('ignores selected ids that are not visible when reading its state', () => {
    expect(headerCheckboxState(new Set(['d', 'e']), filtered)).toBe('none');
    expect(headerCheckboxState(new Set(['a', 'b', 'c', 'd']), filtered)).toBe('all');
  });

  it('reads none with nothing visible', () => {
    expect(headerCheckboxState(new Set(['a']), [])).toBe('none');
  });
});

describe('row checkbox', () => {
  it('adds and removes one rule without touching the rest', () => {
    const selected = toggleInSet(new Set(['a', 'c']), 'b');
    expect(selected).toEqual(new Set(['a', 'b', 'c']));
    expect(toggleInSet(selected, 'a')).toEqual(new Set(['b', 'c']));
  });
});

describe('pruning when the filters change', () => {
  it('drops every selected rule the filters no longer show', () => {
    expect(pruneSelection(new Set(['a', 'b', 'd', 'e']), filtered)).toEqual(new Set(['a', 'b']));
  });

  it('returns the same set when every selected rule is still visible', () => {
    const selected = new Set(['a', 'c']);
    expect(pruneSelection(selected, filtered)).toBe(selected);
  });

  it('empties the selection when nothing is visible', () => {
    expect(pruneSelection(new Set(['a', 'b']), [])).toEqual(new Set());
  });
});

describe('what each action would change', () => {
  it('counts disabled rules for enable and enabled rules for disable', () => {
    expect(bulkChanges(new Set(['a', 'b', 'c']), filtered)).toEqual({ enable: ['b'], disable: ['a', 'c'] });
  });

  it('gives an empty list for an action with nothing to change', () => {
    expect(bulkChanges(new Set(['a', 'c']), filtered)).toEqual({ enable: [], disable: ['a', 'c'] });
  });

  it('never counts a selected rule that is not visible', () => {
    expect(bulkChanges(new Set(['a', 'd', 'e']), filtered)).toEqual({ enable: [], disable: ['a'] });
  });
});

describe('request body', () => {
  it('sends only the ids the action changes, under the action\'s own key', () => {
    const changes = bulkChanges(new Set(['a', 'b', 'c']), filtered);
    expect(bulkRequestBody('disable', changes.disable)).toEqual({ disable: ['a', 'c'] });
    expect(bulkRequestBody('enable', changes.enable)).toEqual({ enable: ['b'] });
  });
});
