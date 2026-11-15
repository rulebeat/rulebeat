/**
 * #274: where a person's trend is read from, and what the trend widget says when there is none.
 */
import { describe, expect, it } from 'vitest';
import { buildAccess, everythingAccess, NO_ACCESS, parseScope, type Access } from '@/lib/access-model';
import { TREND_FILTER_SUPPORT, trendAllowedFor, trendScopeOf, trendUnavailableMessage } from '@/lib/trend-scope';
import type { WidgetFilters } from '@/lib/dashboard-filters';

const SUB_ONE = '00000000-0000-0000-0000-00000000000a';
const SUB_TWO = '00000000-0000-0000-0000-00000000000b';
const GROUP = '/providers/Microsoft.Management/managementGroups/mg-example';

const holding = (paths: string[], subscriptions?: string[]): Access =>
  buildAccess(
    paths.map(path => ({ tenantId: 't', scope: parseScope(path)!, role: 'viewer' as const })),
    'manual',
    subscriptions ? [{ tenantId: 't', path: GROUP, role: 'viewer', groups: ['mg-example'], subscriptions }] : [],
  );

describe('trendScopeOf', () => {
  it('serves Everything from the install-wide row, or from the one subscription the filter names', () => {
    expect(trendScopeOf(everythingAccess('admin'), undefined)).toEqual({ available: true, subscriptionId: undefined });
    expect(trendScopeOf(everythingAccess('editor'), [SUB_TWO])).toEqual({ available: true, subscriptionId: SUB_TWO });
    expect(trendScopeOf(everythingAccess('editor'), [SUB_ONE, SUB_TWO])).toEqual({ available: true, subscriptionId: undefined });
  });

  it('gives a person with no whole subscription the reason, whatever the filter', () => {
    const resourceGroup = holding([`/subscriptions/${SUB_ONE}/resourceGroups/rg-one`]);
    const none = { available: false, reason: 'no-whole-subscription' };
    expect(trendScopeOf(resourceGroup, undefined)).toEqual(none);
    expect(trendScopeOf(resourceGroup, [SUB_ONE])).toEqual(none);
    expect(trendScopeOf(NO_ACCESS, undefined)).toEqual(none);
  });

  it('serves a person on one subscription from its rows, with or without the filter', () => {
    const access = holding([`/subscriptions/${SUB_ONE}`]);
    expect(trendScopeOf(access, undefined)).toEqual({ available: true, subscriptionId: SUB_ONE });
    expect(trendScopeOf(access, [SUB_ONE.toUpperCase()])).toEqual({ available: true, subscriptionId: SUB_ONE.toUpperCase() });
  });

  it('serves a person on one subscription and a resource group inside it from the subscription', () => {
    const access = holding([`/subscriptions/${SUB_ONE}`, `/subscriptions/${SUB_ONE}/resourceGroups/rg-one`]);
    expect(trendScopeOf(access, undefined)).toEqual({ available: true, subscriptionId: SUB_ONE });
  });

  it('asks for a choice when what they hold is wider than the one subscription', () => {
    const choose = { available: false, reason: 'choose-subscription' };
    expect(trendScopeOf(holding([`/subscriptions/${SUB_ONE}`, '@directory']), undefined)).toEqual(choose);
    expect(trendScopeOf(holding([`/subscriptions/${SUB_ONE}`, `/subscriptions/${SUB_TWO}/resourceGroups/rg-one`]), undefined)).toEqual(choose);
    expect(trendScopeOf(holding([`/subscriptions/${SUB_ONE}`, `/subscriptions/${SUB_TWO}`]), undefined)).toEqual(choose);
  });

  it('asks a management group Viewer to choose, and serves the one subscription they filter to', () => {
    const access = holding([GROUP], [SUB_ONE, SUB_TWO]);
    expect(trendScopeOf(access, undefined)).toEqual({ available: false, reason: 'choose-subscription' });
    expect(trendScopeOf(access, [SUB_ONE, SUB_TWO])).toEqual({ available: false, reason: 'choose-subscription' });
    expect(trendScopeOf(access, [SUB_TWO])).toEqual({ available: true, subscriptionId: SUB_TWO });
  });

  it('asks for a choice when the filter names a subscription they do not hold whole', () => {
    expect(trendScopeOf(holding([`/subscriptions/${SUB_ONE}`]), [SUB_TWO])).toEqual({ available: false, reason: 'choose-subscription' });
  });

  it('asks for a choice from a management group holding one subscription, since findings placed at the group lie outside it', () => {
    expect(trendScopeOf(holding([GROUP], [SUB_ONE]), undefined)).toEqual({ available: false, reason: 'choose-subscription' });
  });
});

describe('trendScopeOf for the Directory', () => {
  const directory = { available: true, subscriptionId: 'directory' };

  it('serves a Directory-only person the Directory with no filter, or when the filter names it', () => {
    const access = holding(['@directory']);
    expect(trendScopeOf(access, undefined)).toEqual(directory);
    expect(trendScopeOf(access, ['directory'])).toEqual(directory);
    expect(trendScopeOf(access, ['Directory'])).toEqual(directory);
  });

  it('serves someone who holds the Directory and more when the filter names only the Directory, and asks for a choice with no filter', () => {
    const access = holding([`/subscriptions/${SUB_ONE}`, '@directory']);
    expect(trendScopeOf(access, ['directory'])).toEqual(directory);
    expect(trendScopeOf(access, undefined)).toEqual({ available: false, reason: 'choose-subscription' });
    expect(trendScopeOf(holding(['@directory', GROUP], [SUB_ONE]), ['directory'])).toEqual(directory);
  });

  it('serves the Directory to Everything when the filter names it', () => {
    expect(trendScopeOf(everythingAccess('editor'), ['directory'])).toEqual({ available: true, subscriptionId: 'directory' });
  });

  it('never serves the Directory to someone who does not hold it', () => {
    expect(trendScopeOf(holding([`/subscriptions/${SUB_ONE}`]), ['directory'])).toEqual({ available: false, reason: 'choose-subscription' });
    expect(trendScopeOf(holding([`/subscriptions/${SUB_ONE}/resourceGroups/rg-one`]), ['directory'])).toEqual({ available: false, reason: 'no-whole-subscription' });
    expect(trendScopeOf(NO_ACCESS, ['directory'])).toEqual({ available: false, reason: 'no-whole-subscription' });
  });

  it('does not serve the Directory beside a subscription in the filter', () => {
    expect(trendScopeOf(holding([`/subscriptions/${SUB_ONE}`, '@directory']), ['directory', SUB_ONE])).toEqual({ available: false, reason: 'choose-subscription' });
  });
});

describe('trendAllowedFor', () => {
  const window = { mode: 'relative', days: 7 } as const;
  const unavailable: Record<string, Partial<WidgetFilters>> = {
    resourceGroups: { resourceGroups: ['rg-one'] },
    tags: { tags: ['prod'] },
    severities: { severities: ['high'] },
    ruleIds: { ruleIds: ['rule-a'] },
  };

  it('allows category, the date window and at most one subscription or the Directory', () => {
    expect(trendAllowedFor({ dateWindow: window })).toBe(true);
    expect(trendAllowedFor({ dateWindow: window, categories: ['security'] })).toBe(true);
    expect(trendAllowedFor({ dateWindow: window, subscriptions: [SUB_ONE] })).toBe(true);
    expect(trendAllowedFor({ dateWindow: window, subscriptions: ['directory'] })).toBe(true);
    expect(trendAllowedFor({ dateWindow: window, categories: ['security'], subscriptions: [SUB_ONE] })).toBe(true);
  });

  it('refuses more than one subscriptions value', () => {
    expect(trendAllowedFor({ dateWindow: window, subscriptions: [SUB_ONE, SUB_TWO] })).toBe(false);
    expect(trendAllowedFor({ dateWindow: window, subscriptions: [SUB_ONE, 'directory'] })).toBe(false);
  });

  it('treats an empty list as no filter', () => {
    expect(trendAllowedFor({ dateWindow: window, tags: [], resourceGroups: [], severities: [], ruleIds: [] })).toBe(true);
  });

  it('refuses every key the allow-list marks unavailable, and the test names them all', () => {
    const marked = Object.entries(TREND_FILTER_SUPPORT).filter(([, v]) => v === 'unavailable').map(([k]) => k).sort();
    expect(Object.keys(unavailable).sort()).toEqual(marked);
    for (const [key, filters] of Object.entries(unavailable)) {
      expect(trendAllowedFor({ dateWindow: window, ...filters }), key).toBe(false);
    }
  });

  it('refuses a resource group even beside the one subscription it sits in', () => {
    expect(trendAllowedFor({ dateWindow: window, subscriptions: [SUB_ONE], resourceGroups: ['rg-one'] })).toBe(false);
  });
});

describe('trendUnavailableMessage', () => {
  it('names the subscription and the Directory in the title', () => {
    expect(trendUnavailableMessage('no-whole-subscription').title).toBe('Trend history is kept per subscription and the Directory');
    expect(trendUnavailableMessage('choose-subscription').title).toBe('Trend history is kept per subscription and the Directory');
  });

  it('tells a person with no whole subscription that history is kept per subscription', () => {
    const message = trendUnavailableMessage('no-whole-subscription');
    expect(message.detail).toContain('no whole subscription');
  });

  it('tells a person with several to choose one', () => {
    const message = trendUnavailableMessage('choose-subscription');
    expect(message.detail).toContain('Choose one subscription');
  });
});
