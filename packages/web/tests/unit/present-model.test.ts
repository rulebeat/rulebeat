/**
 * The pure parts of Present: the `?refresh=` override, the addresses Exit and the toolbar entry use, the
 * URL filters laid over a dashboard's saved ones, and the two browser questions (is Full screen offered,
 * what does Esc do) answered from a document-shaped value so no browser is needed.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRESENT_REFRESH_SECONDS, escapeAction, exitHref, offersFullScreen, presentFilters, presentHref, presentRefreshSeconds,
} from '@/lib/present';
import type { DashboardConfig } from '@/lib/types';

const EMPTY: DashboardConfig = { widgets: [] };

describe('presentRefreshSeconds', () => {
  it.each([
    ['30s', 30],
    ['1m', 60],
    ['5m', 300],
    ['15m', 900],
    ['30m', 1800],
    ['1h', 3600],
  ])('accepts %s', (token, seconds) => {
    // The dashboard's own interval is deliberately different, so a fall back would show.
    expect(presentRefreshSeconds(token, 45)).toBe(seconds);
  });

  it.each(['off', 'Off', '', '10s', '2m', '60', '1H', '5M', ' 5m', '5m ', '1d', 'abc'])('falls back to the dashboard interval for %j', (raw) => {
    expect(presentRefreshSeconds(raw, 900)).toBe(900);
  });

  it('falls back when the parameter is absent or repeated', () => {
    expect(presentRefreshSeconds(undefined, 900)).toBe(900);
    expect(presentRefreshSeconds(['30s', '1m'], 900)).toBe(900);
  });

  it('uses 5 minutes when the dashboard refresh is Off or was never set', () => {
    expect(DEFAULT_PRESENT_REFRESH_SECONDS).toBe(300);
    expect(presentRefreshSeconds('off', 0)).toBe(300);
    expect(presentRefreshSeconds(undefined, undefined)).toBe(300);
    expect(presentRefreshSeconds('nope', 0)).toBe(300);
  });
});

describe('the addresses Present moves between', () => {
  it('Exit leads to the ordinary view with the URL filters and without ?refresh=', () => {
    expect(exitHref('d1', new URLSearchParams('severities=high,critical&refresh=30s&window=30')))
      .toBe('/dashboards/d1?severities=high%2Ccritical&window=30');
  });

  it('Exit has no query string when nothing but ?refresh= was there', () => {
    expect(exitHref('d1', new URLSearchParams('refresh=1m'))).toBe('/dashboards/d1');
    expect(exitHref('d1', new URLSearchParams(''))).toBe('/dashboards/d1');
  });

  it('the toolbar entry opens Present with the current URL filters', () => {
    expect(presentHref('d1', new URLSearchParams('categories=security&window=7')))
      .toBe('/dashboards/d1/present?categories=security&window=7');
    expect(presentHref('d1', new URLSearchParams(''))).toBe('/dashboards/d1/present');
  });

  it('the toolbar entry does not carry a ?refresh= over', () => {
    expect(presentHref('d1', new URLSearchParams('refresh=30s&tags=a'))).toBe('/dashboards/d1/present?tags=a');
  });
});

describe('presentFilters', () => {
  it('shows the dashboard\'s saved filters when the address holds none', () => {
    const config: DashboardConfig = {
      widgets: [],
      filters: { categories: ['security'], subscriptions: ['sub-a'] },
      dateWindow: { mode: 'relative', days: 30 },
    };
    expect(presentFilters(config, {})).toEqual({
      categories: ['security'], subscriptions: ['sub-a'], resourceGroups: [], tags: [], severities: [], ruleIds: [],
      dateWindow: { mode: 'relative', days: 30 },
    });
  });

  it('reads the legacy windowDays and the 7 day default the way the ordinary view does', () => {
    expect(presentFilters({ widgets: [], windowDays: 30 }, {}).dateWindow).toEqual({ mode: 'relative', days: 30 });
    expect(presentFilters(EMPTY, {}).dateWindow).toEqual({ mode: 'relative', days: 7 });
  });

  it('lets an address filter replace the saved one for that dimension only', () => {
    const config: DashboardConfig = { widgets: [], filters: { categories: ['security'], tags: ['prod'] } };
    const filters = presentFilters(config, { categories: 'cost,identity', severities: 'high' });
    expect(filters.categories).toEqual(['cost', 'identity']);
    expect(filters.severities).toEqual(['high']);
    expect(filters.tags).toEqual(['prod']);
  });

  it('applies a window and a custom range from the address', () => {
    expect(presentFilters(EMPTY, { window: '30' }).dateWindow).toEqual({ mode: 'relative', days: 30 });
    expect(presentFilters(EMPTY, { from: '2026-01-01', to: '2026-01-31' }).dateWindow)
      .toEqual({ mode: 'custom', from: '2026-01-01', to: '2026-01-31' });
  });

  it('ignores an unusable window and an empty list', () => {
    const config: DashboardConfig = { widgets: [], filters: { tags: ['prod'] }, dateWindow: { mode: 'relative', days: 30 } };
    const filters = presentFilters(config, { window: 'soon', tags: ',', from: '2026-01-01' });
    expect(filters.dateWindow).toEqual({ mode: 'relative', days: 30 });
    expect(filters.tags).toEqual(['prod']);
  });

  it('carries the suppressed switch', () => {
    expect(presentFilters(EMPTY, { suppressed: '1' }).includeSuppressed).toBe(true);
    expect(presentFilters(EMPTY, {}).includeSuppressed).toBeUndefined();
  });
});

describe('offersFullScreen', () => {
  it('is offered when the browser supports it and the page is not already full screen', () => {
    expect(offersFullScreen({ fullscreenEnabled: true, fullscreenElement: null })).toBe(true);
  });

  it('is hidden when the browser does not support it', () => {
    expect(offersFullScreen({ fullscreenEnabled: false, fullscreenElement: null })).toBe(false);
  });

  it('is hidden when the page is already full screen', () => {
    expect(offersFullScreen({ fullscreenEnabled: true, fullscreenElement: {} as Element })).toBe(false);
  });
});

describe('escapeAction', () => {
  it('leaves Present on Esc', () => {
    expect(escapeAction({ key: 'Escape' }, { fullscreenElement: null })).toBe('exit');
  });

  it('only leaves full screen when the browser is in it: the first Esc is the browser\'s', () => {
    expect(escapeAction({ key: 'Escape' }, { fullscreenElement: {} as Element })).toBe('none');
  });

  it('leaves Present on Esc where the browser has no Fullscreen API (the element is undefined)', () => {
    expect(escapeAction({ key: 'Escape' }, { fullscreenElement: undefined })).toBe('exit');
  });

  it('ignores every other key and an Esc something else already handled', () => {
    expect(escapeAction({ key: 'Enter' }, { fullscreenElement: null })).toBe('none');
    expect(escapeAction({ key: 'Escape', defaultPrevented: true }, { fullscreenElement: null })).toBe('none');
  });
});
