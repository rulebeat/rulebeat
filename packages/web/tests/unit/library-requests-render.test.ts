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
import type { AuthorLibraryRequest, LibraryRequestSummary, Rule } from '@/lib/types';

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
