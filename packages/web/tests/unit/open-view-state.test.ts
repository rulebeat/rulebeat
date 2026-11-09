/**
 * #373: a saved view the address names stays open until the viewer closes it or a read says it no longer
 * opens, and a view that no longer opens is announced once and dropped.
 */
import { describe, expect, it } from 'vitest';
import { OPEN_VIEW_INITIAL, afterClose, afterDismiss, afterRead, openViewIdOf } from '@/lib/open-view-state';

describe('the open saved view', () => {
  it('is the one the address names until it is let go of', () => {
    expect(openViewIdOf('v1', OPEN_VIEW_INITIAL)).toBe('v1');
    expect(openViewIdOf(null, OPEN_VIEW_INITIAL)).toBeNull();
    expect(openViewIdOf('v1', { droppedId: 'v1', gone: false })).toBeNull();
  });

  it('is open again when the address names another view than the one let go of', () => {
    expect(openViewIdOf('v2', { droppedId: 'v1', gone: false })).toBe('v2');
  });

  it('is dropped and announced when a read says it no longer opens', () => {
    const state = afterRead(OPEN_VIEW_INITIAL, 'v1', true);
    expect(state).toEqual({ droppedId: 'v1', gone: true });
    expect(openViewIdOf('v1', state)).toBeNull();
  });

  it('is left alone by a read that opened it, and by a flag with no view open', () => {
    expect(afterRead(OPEN_VIEW_INITIAL, 'v1', false)).toBe(OPEN_VIEW_INITIAL);
    expect(afterRead(OPEN_VIEW_INITIAL, null, true)).toBe(OPEN_VIEW_INITIAL);
  });

  it('is announced once: reading again after the drop, or dismissing, raises nothing more', () => {
    const gone = afterRead(OPEN_VIEW_INITIAL, 'v1', true);
    const dismissed = afterDismiss(gone);
    expect(dismissed.gone).toBe(false);
    expect(afterRead(dismissed, openViewIdOf('v1', dismissed), true)).toBe(dismissed);
  });

  it('is dropped without a notice when the viewer closes it', () => {
    expect(afterClose(OPEN_VIEW_INITIAL, 'v1')).toEqual({ droppedId: 'v1', gone: false });
    expect(afterClose(OPEN_VIEW_INITIAL, null)).toBe(OPEN_VIEW_INITIAL);
  });
});
