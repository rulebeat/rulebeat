/**
 * After a scan is started the screen waits four seconds and then reads what the scan stored. A tab
 * that reads its own view is told to read it again; every other tab refreshes the page, as it did
 * before the explorer read its own view.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCAN_REFRESH_DELAY_MS, refreshAfterScan } from '@/lib/scan-refresh';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('refreshAfterScan', () => {
  it('waits four seconds', () => {
    expect(SCAN_REFRESH_DELAY_MS).toBe(4000);
  });

  it('tells a tab that reads its own view to read it again, and does not refresh the page', () => {
    const finished = vi.fn();
    const refreshPage = vi.fn();
    refreshAfterScan(finished, refreshPage);
    vi.advanceTimersByTime(3999);
    expect(finished).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(finished).toHaveBeenCalledTimes(1);
    expect(refreshPage).not.toHaveBeenCalled();
  });

  it('refreshes the page for a tab that does not', () => {
    const refreshPage = vi.fn();
    refreshAfterScan(undefined, refreshPage);
    vi.advanceTimersByTime(3999);
    expect(refreshPage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refreshPage).toHaveBeenCalledTimes(1);
  });
});
