/**
 * The auto-refresh choice outside edit mode applies only to the open page; the saved interval is set in
 * edit mode and saved with the layout (ADR 0013).
 */
import { describe, expect, it, vi } from 'vitest';
import { NO_REFRESH_CHOICE, pageInterval, pickInterval, savedInterval, shownInterval } from '@/lib/dashboard-refresh';
import type { Dashboard } from '@/lib/types';

vi.mock('next/navigation', () => ({
  useRouter: () => ({}), usePathname: () => '', useSearchParams: () => new URLSearchParams(),
}));

const { layoutConfig } = await import('@/app/(app)/dashboards/[id]/dashboard-grid-client');

describe('picking an interval outside edit mode', () => {
  it('changes the open page and leaves the layout and the saved interval alone', () => {
    const { choice, layoutChanged } = pickInterval(false, NO_REFRESH_CHOICE, 30);
    expect(layoutChanged).toBe(false);
    expect(pageInterval(0, choice)).toBe(30);
    expect(shownInterval(false, 0, choice)).toBe(30);
    expect(savedInterval(0, choice)).toBe(0);
  });
});

describe('picking an interval in edit mode', () => {
  it('is what the layout save carries, and does not move the open page', () => {
    const { choice, layoutChanged } = pickInterval(true, NO_REFRESH_CHOICE, 60);
    expect(layoutChanged).toBe(true);
    expect(shownInterval(true, 0, choice)).toBe(60);
    expect(pageInterval(0, choice)).toBe(0);
    const config = { widgets: [] } as Dashboard['config'];
    expect(layoutConfig(config, savedInterval(0, choice), []).autoRefresh).toBe(60);
  });

  it('shows the saved interval before anything is picked, whatever the page chose', () => {
    const { choice } = pickInterval(false, NO_REFRESH_CHOICE, 30);
    expect(shownInterval(true, 300, choice)).toBe(300);
    expect(savedInterval(300, choice)).toBe(300);
  });
});
