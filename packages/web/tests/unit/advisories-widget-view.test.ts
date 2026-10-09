/**
 * Issue #179: what the Advisories dashboard widget shows. The codebase has no component-rendering
 * layer (Vitest runs in `node`), so the widget's decision about which state to render lives in
 * lib/advisories-widget.ts, where it can be exercised directly. The widget imports
 * WidgetUnavailable and renders it for the 'unavailable' state; widget-unavailable-coverage.test.ts
 * guards that import.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advisoriesWidgetView, formatLastSeen, ADVISORIES_WIDGET_EMPTY, type AdvisoriesWidgetData } from '@/lib/advisories-widget';

const ITEM = {
  fingerprint: 'fp', ruleId: 'r', ruleName: 'Rule', resourceId: '/x', resourceName: 'vm-1',
  category: 'security', severity: 'high' as const, lastSeenAt: '2026-06-01T00:00:00.000Z',
};
const data = (over: Partial<AdvisoriesWidgetData> = {}): AdvisoriesWidgetData => ({
  items: [], total: 0, hasAdvisoryRules: true, ...over,
});

describe('advisoriesWidgetView', () => {
  it('is loading while the first fetch is in flight', () => {
    expect(advisoriesWidgetView({ loading: true, failed: false, data: null })).toBe('loading');
  });

  it('is unavailable when the fetch failed, never the empty state', () => {
    expect(advisoriesWidgetView({ loading: false, failed: true, data: null })).toBe('unavailable');
  });

  it('stays unavailable when a failed retry still holds earlier data', () => {
    expect(advisoriesWidgetView({ loading: false, failed: true, data: data({ hasAdvisoryRules: false }) })).toBe('unavailable');
  });

  it('is unavailable rather than empty when a successful fetch somehow returned no body', () => {
    expect(advisoriesWidgetView({ loading: false, failed: false, data: null })).toBe('unavailable');
  });

  it('tells no Advisory rules apart from no open Advisories', () => {
    expect(advisoriesWidgetView({ loading: false, failed: false, data: data({ hasAdvisoryRules: false }) })).toBe('no-rules');
    expect(advisoriesWidgetView({ loading: false, failed: false, data: data() })).toBe('none-open');
  });

  it('lists when there are open Advisories', () => {
    expect(advisoriesWidgetView({ loading: false, failed: false, data: data({ items: [ITEM], total: 1 }) })).toBe('list');
  });
});

describe('formatLastSeen', () => {
  it('shows a midnight-UTC date as that calendar day, whatever the local zone', () => {
    expect(formatLastSeen('2026-06-01T00:00:00.000Z')).toBe('Jun 1, 2026');
    expect(formatLastSeen('2026-12-31T23:59:59.000Z')).toBe('Dec 31, 2026');
  });

  it('says Unknown for no date or one that does not parse', () => {
    expect(formatLastSeen(undefined)).toBe('Unknown');
    expect(formatLastSeen('not a date')).toBe('Unknown');
  });
});

describe('the empty copy', () => {
  it('says why in each case, in different words, with no em dash', () => {
    const { 'no-rules': noRules, 'none-open': noneOpen } = ADVISORIES_WIDGET_EMPTY;
    expect(noRules.title).toBe('No Advisory rules are enabled');
    expect(noneOpen.title).toBe('No open Advisories');
    expect(noRules.title).not.toBe(noneOpen.title);
    expect(noRules.hint).not.toBe(noneOpen.hint);
    for (const text of [noRules.title, noRules.hint, noneOpen.title, noneOpen.hint]) {
      expect(text).not.toContain('—');
    }
  });
});

describe('lib/advisories-widget.ts stays client-safe', () => {
  it('has no import from drizzle or a lib/db module', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'advisories-widget.ts'), 'utf8');
    expect(/from\s+['"]drizzle-orm['"]/.test(source) || /from\s+['"][^'"]*\/db\//.test(source)).toBe(false);
  });
});
