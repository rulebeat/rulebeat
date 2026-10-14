/**
 * #282: what the Library and a Personal rule show about Library requests. The open count belongs to a
 * reviewer and to no one else; the author reads the status of their request, the reason when it was
 * rejected and the library rule it became, and is offered only the control that fits that status.
 * Rendered on the server, in the style of personal-copy-render.test.ts.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LibraryClient } from '@/app/(app)/library/library-client';
import { PersonalRuleClient } from '@/app/(app)/library/personal/[id]/personal-rule-client';
import { RequestsTab } from '@/app/(app)/library/requests-tab';
import { LibraryRequestReviewClient } from '@/app/(app)/library/requests/[id]/library-request-review-client';
import type { AuthorLibraryRequest, LibraryRequestDetail, LibraryRequestSummary, Rule } from '@/lib/types';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => '/library',
  useSearchParams: () => new URLSearchParams(),
}));

const summary = (id: string, name: string): LibraryRequestSummary => ({
  id, name, category: 'security', severity: 'high', queryBackend: 'resource-graph',
  createdAt: '2026-03-01T10:00:00.000Z', author: { id: 'author-1', label: 'author@example.com' }, isResubmission: false,
});

const library = (requests: LibraryRequestSummary[] | null, initialSection?: string) => renderToStaticMarkup(createElement(LibraryClient, {
  initialRules: [], personalRules: [], personalWriteBlockedReason: null,
  personalCopyReasons: { 'resource-graph': null, 'microsoft-graph': null, 'log-analytics': null }, newerVersions: {}, packManifest: {},
  categories: [], initialSidebarPinned: true, canAuthor: true, canDelete: true, initialSection, requests,
}));

describe('the Requests section of the Library', () => {
  it('shows a reviewer the section with the number of open requests', () => {
    const html = library([summary('r1', 'First'), summary('r2', 'Second'), summary('r3', 'Third')]);
    expect(html).toMatch(/Requests<\/span><span[^>]*>3<\/span>/);
  });

  it('shows the count as zero when nothing is open', () => {
    expect(library([])).toMatch(/Requests<\/span><span[^>]*>0<\/span>/);
  });

  it('shows no one else the section or any count', () => {
    const html = library(null);
    expect(html).not.toContain('Requests');
  });

  it('opens a person with no access to Requests on All rules, not on an empty requests page', () => {
    const html = library(null, 'requests');
    expect(html).not.toContain('No open requests');
    expect(html).not.toContain('Personal rules that Editors have sent');
  });

  it('lists the open requests for a reviewer, each linking to its review page', () => {
    const html = library([summary('r1', 'First request')], 'requests');
    expect(html).toContain('First request');
    expect(html).toContain('href="/library/requests/r1"');
    expect(html).toContain('author@example.com');
  });

  it('says why the list is empty', () => {
    const html = renderToStaticMarkup(createElement(RequestsTab, { requests: [], categories: [] }));
    expect(html).toContain('No open requests');
    expect(html).toContain('Nothing is waiting for a decision');
  });
});

const rule = { id: 'personal-1', name: 'Mine', description: '', category: 'security', severity: 'high', enabled: true, type: 'custom', kind: 'state', queryBackend: 'resource-graph', scope: { level: 'subscription' }, resourceTypes: [], conditions: [], rawKql: 'resources | project id', tags: [] } as unknown as Rule;

const request = (status: AuthorLibraryRequest['status'], extra: Partial<AuthorLibraryRequest> = {}): AuthorLibraryRequest => ({
  id: `req-${status}`, status, createdAt: '2026-03-01T10:00:00.000Z', ...extra,
});

const page = (
  requests: AuthorLibraryRequest[],
  options: { copiedTo?: { id: string; name: string } | null; copyToLibrary?: { reason: string | null } | null; canWrite?: boolean } = {},
) => renderToStaticMarkup(createElement(PersonalRuleClient, {
  rule, source: null, updatedAt: '2026-01-01T00:00:00.000Z', results: [], lastRunCovered: null, allTags: [], categories: [],
  canWrite: options.canWrite ?? true, runBlockedReason: null, requests, copiedTo: options.copiedTo ?? null, copyToLibrary: options.copyToLibrary ?? null,
}));

describe('a Personal rule and its Library request', () => {
  it('offers Send to library when the rule has no request', () => {
    const html = page([]);
    expect(html).toContain('Send to library');
    expect(html).not.toContain('Withdraw');
    expect(html).not.toContain('Resubmit');
  });

  it('says an open request waits, and offers Withdraw instead of Send', () => {
    const html = page([request('open')]);
    expect(html).toContain('A reviewer has not decided yet');
    expect(html).toContain('Withdraw');
    expect(html).not.toContain('Send to library');
    expect(html).not.toContain('Resubmit');
  });

  it('shows the reason a request was rejected, and offers Resubmit', () => {
    const html = page([request('rejected', { rejectionReason: 'Scope it to production.', reviewedAt: '2026-03-02T10:00:00.000Z' })]);
    expect(html).toContain('Reason: Scope it to production.');
    expect(html).toContain('Resubmit');
    expect(html).not.toContain('Send to library');
    expect(html).not.toContain('Withdraw');
  });

  it('links to the library rule an approval created, and offers no second send', () => {
    const html = page([request('approved', { libraryRule: { id: 'lib-1', name: 'VM baseline' } })]);
    expect(html).toContain('href="/rules/lib-1"');
    expect(html).toContain('VM baseline');
    expect(html).not.toContain('Send to library');
  });

  it('says so when the approved library rule has been deleted, and offers Send again', () => {
    const html = page([request('approved')]);
    expect(html).toContain('has since been deleted');
    expect(html).toContain('Send to library');
  });

  it('offers Send to library again after a withdrawal', () => {
    expect(page([request('withdrawn')])).toContain('Send to library');
  });

  it('reads only the newest request when there are several', () => {
    const html = page([request('open'), request('rejected', { rejectionReason: 'An old reason.' })]);
    expect(html).toContain('A reviewer has not decided yet');
    expect(html).not.toContain('An old reason.');
  });

  it('links to the library rule a direct copy made', () => {
    const html = page([], { copiedTo: { id: 'lib-2', name: 'Copied rule' } });
    expect(html).toContain('href="/rules/lib-2"');
    expect(html).toContain('Copied to the library');
  });

  it('shows Copy to library to a reviewer only', () => {
    expect(page([])).not.toContain('Copy to library');
    expect(page([], { copyToLibrary: { reason: null } })).toContain('Copy to library');
  });

  it('carries the server\'s reason on a Copy to library that is off', () => {
    const html = page([], { copyToLibrary: { reason: 'This rule is already in the library as "Copied rule".' } });
    expect(html).toContain('title="This rule is already in the library as &quot;Copied rule&quot;."');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="This rule is already in the library/);
  });

  it('shows a demoted author the status and none of the controls', () => {
    const html = page([request('rejected', { rejectionReason: 'Too broad.' })], { canWrite: false });
    expect(html).toContain('Reason: Too broad.');
    expect(html).not.toContain('Resubmit');
    expect(html).not.toContain('Send to library');
    expect(page([request('open')], { canWrite: false })).not.toContain('Withdraw');
  });
});

describe('a Personal rule and update requests (#283)', () => {
  const targets = [{ id: 'lib-1', name: 'VM baseline' }, { id: 'lib-2', name: 'Source rule' }];
  const withTargets = (requests: AuthorLibraryRequest[], extra: { updateTargets?: { id: string; name: string }[]; newOnlyReason?: string | null; canWrite?: boolean } = {}) =>
    renderToStaticMarkup(createElement(PersonalRuleClient, {
      rule, source: null, updatedAt: '2026-01-01T00:00:00.000Z', results: [], lastRunCovered: null, allTags: [], categories: [],
      canWrite: extra.canWrite ?? true, runBlockedReason: null, requests, copiedTo: null, copyToLibrary: null,
      updateTargets: extra.updateTargets ?? targets, newOnlyReason: extra.newOnlyReason ?? null,
    }));

  it('offers an update to each eligible target next to Send as new rule', () => {
    const html = withTargets([]);
    expect(html).toContain('Send as new rule');
    expect(html).toContain('Send as update to VM baseline');
    expect(html).toContain('Send as update to Source rule');
    expect(html).not.toContain('Send to library');
  });

  it('keeps offering updates after an approval, with no second new-rule send', () => {
    const html = withTargets([request('approved', { libraryRule: { id: 'lib-1', name: 'VM baseline' } })], { updateTargets: [targets[0]!] });
    expect(html).toContain('Send as update to VM baseline');
    expect(html).not.toContain('Send as new rule');
    expect(html).not.toContain('Send to library');
  });

  it('offers updates after a rejection beside Resubmit, and none while a request is open', () => {
    const rejected = withTargets([request('rejected', { rejectionReason: 'No.' })]);
    expect(rejected).toContain('Resubmit');
    expect(rejected).toContain('Send as update to VM baseline');
    const open = withTargets([request('open', { isUpdate: true, target: targets[0]! })]);
    expect(open).not.toContain('Send as update');
    expect(open).toContain('as an update to &quot;VM baseline&quot;');
  });

  it('offers no update when there is no eligible target, and says why for a built-in source', () => {
    const reason = 'A copy of a built-in rule can only be sent as a new rule.';
    const html = withTargets([], { updateTargets: [], newOnlyReason: reason });
    expect(html).not.toContain('Send as update');
    expect(html).toContain('Send to library');
    expect(html).toContain(reason);
  });

  it('offers a demoted author no update', () => {
    expect(withTargets([], { canWrite: false })).not.toContain('Send as update');
  });

  it('tells the author an approved update went to the library rule', () => {
    const html = withTargets([request('approved', { isUpdate: true, target: targets[0]!, libraryRule: targets[0]! })], { updateTargets: [targets[0]!] });
    expect(html).toContain('Sent as an update to');
    expect(html).toContain('href="/rules/lib-1"');
  });
});

describe('the update marker in the requests list (#283)', () => {
  it('marks an update with its target and a new-rule request with nothing', () => {
    const html = renderToStaticMarkup(createElement(RequestsTab, {
      requests: [
        { ...summary('r1', 'Edited rule'), isUpdate: true, target: { id: 'lib-1', name: 'VM baseline' } },
        summary('r2', 'Brand new rule'),
      ],
      categories: [],
    }));
    expect(html).toContain('Update to VM baseline');
    expect(html.match(/Update to /g)).toHaveLength(1);
  });
});

describe('the review page of an update request (#283)', () => {
  const detail = (extra: Partial<LibraryRequestDetail> = {}): LibraryRequestDetail => ({
    ...summary('r1', 'Edited rule'), isUpdate: true, target: { id: 'lib-1', name: 'VM baseline' }, status: 'open', description: 'd',
    kql: 'resources | project id', targetChanged: false, targetEnabled: true,
    diff: [{ kind: 'same', text: 'Category: security' }, { kind: 'removed', text: 'Severity: high' }, { kind: 'added', text: 'Severity: low' }],
    definition: { name: 'Edited rule', description: 'd', category: 'security', severity: 'low', queryBackend: 'resource-graph', kind: 'state', tags: [], scope: { level: 'subscription' }, resourceTypes: [], conditions: [] },
    ...extra,
  });
  const review = (request: LibraryRequestDetail) => renderToStaticMarkup(createElement(LibraryRequestReviewClient, {
    request, categories: [{ id: 'security', label: 'Security', sortOrder: 1, isBuiltin: true, createdAt: '2026-01-01T00:00:00.000Z' }],
  }));
  const approveDisabled = (html: string) => /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Approve/.test(html);

  it('shows the target and the line diff, and no warning while the target is as it was', () => {
    const html = review(detail());
    expect(html).toContain('Update to');
    expect(html).toContain('href="/rules/lib-1"');
    expect(html).toContain('aria-label="Definition line diff"');
    expect(html).toContain('Severity: high');
    expect(html).toContain('Severity: low');
    expect(html).not.toContain('changed after this request was sent');
  });

  it('warns when the target changed after the request was sent', () => {
    expect(review(detail({ targetChanged: true }))).toContain('&quot;VM baseline&quot; changed after this request was sent');
  });

  it('says the target is gone, and disables Approve', () => {
    const html = review(detail({ target: null, diff: [] }));
    expect(html).toContain('no longer exists');
    expect(approveDisabled(html)).toBe(true);
    expect(approveDisabled(review(detail()))).toBe(false);
  });

  it('shows no diff, target or warning on a new-rule request', () => {
    const html = review({ ...detail(), isUpdate: false, target: undefined, diff: undefined, targetChanged: undefined, targetEnabled: undefined });
    expect(html).not.toContain('Definition line diff');
    expect(html).not.toContain('changed after this request was sent');
    expect(html).toContain('Starting state');
  });

  it('labels the enabled switch as the target\'s state for an update', () => {
    const html = review(detail());
    expect(html).toContain('Enabled state');
    expect(html).toContain('keeps the state it has now');
  });
});
