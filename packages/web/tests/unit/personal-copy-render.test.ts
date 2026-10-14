/**
 * #281: the Copy to personal control on the rule page and the Library rows. The reason a person cannot use it
 * is worked out on the server by `personalCopyReasons` and carried on the control as its title; a disabled
 * control that said nothing would leave the person guessing. Rendered on the server, in the style of
 * scoped-access-render.test.ts.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LibraryClient } from '@/app/(app)/library/library-client';
import { RuleDetailClient } from '@/app/(app)/rules/[id]/rule-detail-client';
import { PersonalRuleClient } from '@/app/(app)/library/personal/[id]/personal-rule-client';
import { buildAccess, everythingAccess, parseScope, type Access } from '@/lib/access-model';
import { personalCopyReasons, personalWriteBlockedReason } from '@/lib/personal-rule-request';
import { LOGS_PAUSED_MESSAGE } from '@/lib/personal-rule-run';
import { NEEDS_DIRECTORY_MESSAGE, NEEDS_SUBSCRIPTION_MESSAGE } from '@/lib/written-query';
import type { Role } from '@/lib/rbac';
import type { Rule } from '@/lib/types';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => '/library',
  useSearchParams: () => new URLSearchParams(),
}));

const TENANT = '00000000-0000-0000-0000-000000000001';
const SUB = '00000000-0000-0000-0000-00000000000a';

const accessOf = (...held: Array<[string, Role]>): Access =>
  buildAccess(held.map(([path, role]) => ({ tenantId: TENANT, scope: parseScope(path)!, role })), 'manual');

const ruleOn = (queryBackend: string): Rule => ({
  id: `rule-${queryBackend}`, name: 'A shared rule', description: 'Checks things', category: 'security', severity: 'medium', enabled: true,
  type: 'custom', kind: queryBackend === 'log-analytics' ? 'activity' : 'state', queryBackend, scope: { level: 'subscription' },
  resourceTypes: [], conditions: [], rawKql: 'resources | project id', tags: [],
} as unknown as Rule);

const titled = (html: string, title: string): number => html.split(`title="${title.replace(/'/g, '&#x27;')}"`).length - 1;

const library = (rule: Rule, role: Role, access: Access) => renderToStaticMarkup(createElement(LibraryClient, {
  initialRules: [rule], personalRules: [], personalWriteBlockedReason: personalWriteBlockedReason(role, access),
  personalCopyReasons: personalCopyReasons(role, access), newerVersions: {}, packManifest: {}, categories: [],
  initialSidebarPinned: true, canAuthor: false, canDelete: false,
}));

const detail = (rule: Rule, role: Role, access: Access) => renderToStaticMarkup(createElement(RuleDetailClient, {
  rule, canAuthor: false, canVersion: false, personalCopyReasons: personalCopyReasons(role, access),
}));

const EDITOR = accessOf([`/subscriptions/${SUB}`, 'editor'], ['@directory', 'editor']);
const VIEWER = accessOf([`/subscriptions/${SUB}`, 'viewer']);
const GROUPS_ONLY = accessOf([`/subscriptions/${SUB}/resourceGroups/rg-one`, 'editor']);
const NO_DIRECTORY = accessOf([`/subscriptions/${SUB}`, 'editor']);

describe('why Copy to personal is off, worked out on the server', () => {
  it('is on for an Editor with a subscription, and for a Graph rule only with the Directory', () => {
    expect(personalCopyReasons('editor', EDITOR)).toEqual({ 'resource-graph': null, 'microsoft-graph': null, 'log-analytics': LOGS_PAUSED_MESSAGE });
    expect(personalCopyReasons('editor', NO_DIRECTORY)['microsoft-graph']).toBe(NEEDS_DIRECTORY_MESSAGE);
    expect(personalCopyReasons('editor', NO_DIRECTORY)['resource-graph']).toBeNull();
  });

  it('is the subscription message for an Editor whose access is only resource groups', () => {
    expect(personalCopyReasons('editor', GROUPS_ONLY)['resource-graph']).toBe(NEEDS_SUBSCRIPTION_MESSAGE);
  });

  it('is the Editors-only message for a Viewer', () => {
    expect(personalCopyReasons('viewer', VIEWER)['resource-graph']).toContain('Editors');
  });

  it('is on for an Editor on Everything', () => {
    expect(personalCopyReasons('editor', everythingAccess('editor', 'manual'))['microsoft-graph']).toBeNull();
  });
});

describe('the rule page', () => {
  it('offers Copy to personal to an Editor, enabled', () => {
    const html = detail(ruleOn('resource-graph'), 'editor', EDITOR);
    expect(html).toContain('Copy to personal');
    expect(html).not.toContain(NEEDS_SUBSCRIPTION_MESSAGE);
  });

  it('disables it for a Viewer, with the reason', () => {
    const reason = personalCopyReasons('viewer', VIEWER)['resource-graph']!;
    const html = detail(ruleOn('resource-graph'), 'viewer', VIEWER);
    expect(html).toContain('Copy to personal');
    expect(titled(html, reason)).toBe(1);
    expect(html.replace(/ title="[^"]*"/g, '')).toContain(reason);
  });

  it('disables it for an Editor with only resource groups, with the reason', () => {
    const html = detail(ruleOn('resource-graph'), 'editor', GROUPS_ONLY);
    expect(titled(html, NEEDS_SUBSCRIPTION_MESSAGE)).toBe(1);
  });

  it('disables it for a Logs rule, with the Logs-paused reason', () => {
    const html = detail(ruleOn('log-analytics'), 'editor', everythingAccess('editor', 'manual'));
    expect(titled(html, LOGS_PAUSED_MESSAGE)).toBe(1);
  });
});

describe('the Personal rule page', () => {
  const page = (source: { id: string; name: string } | null) => renderToStaticMarkup(createElement(PersonalRuleClient, {
    rule: { ...ruleOn('resource-graph'), id: 'personal-1' }, source, updatedAt: '2026-01-01T00:00:00.000Z', results: [], lastRunCovered: null,
    allTags: [], categories: [], canWrite: true, runBlockedReason: null,
  }));

  it('says which shared rule it was copied from, linking to it', () => {
    const html = page({ id: 'rule-resource-graph', name: 'A shared rule' });
    expect(html).toContain('Copied from');
    expect(html).toContain('href="/rules/rule-resource-graph"');
    expect(html).toContain('A shared rule');
  });

  it('shows nothing when there is no source', () => {
    const html = page(null);
    expect(html).not.toContain('Copied from');
    expect(html).not.toContain('href="/rules/');
  });
});

describe('the Library rows', () => {
  it('offers Copy to personal on a row, enabled for an Editor', () => {
    const html = library(ruleOn('resource-graph'), 'editor', EDITOR);
    expect(html).toContain('title="Copy to personal"');
  });

  it('disables it for a Viewer, with the reason', () => {
    const reason = personalCopyReasons('viewer', VIEWER)['resource-graph']!;
    expect(titled(library(ruleOn('resource-graph'), 'viewer', VIEWER), reason)).toBe(1);
  });

  it('disables it for an Editor with only resource groups, with the reason', () => {
    expect(titled(library(ruleOn('resource-graph'), 'editor', GROUPS_ONLY), NEEDS_SUBSCRIPTION_MESSAGE)).toBe(1);
  });

  it('disables it for a Logs rule, with the Logs-paused reason', () => {
    expect(titled(library(ruleOn('log-analytics'), 'editor', EDITOR), LOGS_PAUSED_MESSAGE)).toBe(1);
  });
});
