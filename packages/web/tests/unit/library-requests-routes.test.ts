/**
 * #282: Library requests for new rules. The real `requireRole` and a real temp database; only the session
 * (`@/auth`) and `createTenantContext` are mocked. An Editor sends a Personal rule to the library, a reviewer
 * (an Admin, or an Editor on Everything) previews it and approves or rejects it, and the author reads the
 * answer on their own rule. A Viewer and an Editor held at a smaller Scope reach none of the reviewer routes.
 *
 * Every id is fake: zero GUIDs and example.com.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { countRows, execRaw, resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { listAllAuditEntries } from '@/lib/db/audit';
import {
  createPersonalRule, getPersonalRule, listPersonalRules, replacePersonalRuleResults, updatePersonalRule,
  type PersonalRule, type PersonalRuleDefinition,
} from '@/lib/db/personal-rules';
import {
  approveLibraryRequest, createLibraryRequest, getLibraryRequest, listLibraryRequestsForPersonalRule, rejectLibraryRequest,
} from '@/lib/db/library-requests';
import { createRule, deleteRule, loadRule, loadRules } from '@/lib/rules';
import type { Rule } from '@rulebeat/core';
import { listFindings } from '@/lib/db/findings';
import { addSuppression, loadSuppressions } from '@/lib/suppressions';
import { EVERYTHING_ACCESS } from '../helpers/access';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';
import { argRow, fakeTenantContext, TEST_SUB_A, TEST_TENANT_ID, type FakeTenantContext } from '../helpers/fake-azure';
import { COPY_TO_LIBRARY_REASON } from '@/lib/library-request-view';
import type { Role } from '@/lib/rbac';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

let fakeCtx: FakeTenantContext;
vi.mock('@/lib/azure-credential', async () => {
  const actual = await vi.importActual<typeof import('@/lib/azure-credential')>('@/lib/azure-credential');
  return { ...actual, createTenantContext: () => Promise.resolve(fakeCtx) };
});

// The real `limitedContext`, watched, so a preview can be shown to go through it.
vi.mock('@/lib/personal-rule-run', async () => {
  const actual = await vi.importActual<typeof import('@/lib/personal-rule-run')>('@/lib/personal-rule-run');
  return { ...actual, limitedContext: vi.fn(actual.limitedContext) };
});
const personalRun = await import('@/lib/personal-rule-run');

const sendRoute = await import('@/app/api/personal-rules/[id]/library-request/route');
const copyRoute = await import('@/app/api/personal-rules/[id]/library-copy/route');
const personalItem = await import('@/app/api/personal-rules/[id]/route');
const listRoute = await import('@/app/api/library-requests/route');
const viewRoute = await import('@/app/api/library-requests/[id]/route');
const previewRoute = await import('@/app/api/library-requests/[id]/preview/route');
const approveRoute = await import('@/app/api/library-requests/[id]/approve/route');
const rulesItem = await import('@/app/api/rules/[id]/route');
const rejectRoute = await import('@/app/api/library-requests/[id]/reject/route');
const withdrawRoute = await import('@/app/api/library-requests/[id]/withdraw/route');
const usersItem = await import('@/app/api/users/[id]/route');

const SUBSCRIPTION_A = `/subscriptions/${TEST_SUB_A}`;
const KQL = 'resources | where type =~ "microsoft.compute/virtualmachines" | project id, name, type, location, resourceGroup, subscriptionId';

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const jsonRequest = (method: string, body?: unknown) => new Request('http://localhost/api', {
  method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});
const empty = (method = 'POST') => new Request('http://localhost/api', { method });

const send = (ruleId: string, body?: unknown) => sendRoute.POST(body === undefined ? empty() : jsonRequest('POST', body), idParams(ruleId));
const withdraw = (id: string) => withdrawRoute.POST(empty(), idParams(id));
const list = () => listRoute.GET();
const view = (id: string) => viewRoute.GET(empty('GET'), idParams(id));
const preview = (id: string, body?: unknown) => previewRoute.POST(body === undefined ? empty() : jsonRequest('POST', body), idParams(id));
const approve = (id: string, body?: unknown) => approveRoute.POST(body === undefined ? empty() : jsonRequest('POST', body), idParams(id));
const reject = (id: string, body?: unknown) => rejectRoute.POST(body === undefined ? empty() : jsonRequest('POST', body), idParams(id));
const copyToLibrary = (ruleId: string) => copyRoute.POST(empty(), idParams(ruleId));
const readPersonal = (ruleId: string) => personalItem.GET(empty('GET'), idParams(ruleId));

const as = (id: string) => mockAuth.mockResolvedValue({ user: { uid: id } });

/** Created, not signed in: a person who can be switched to with `as()`. */
async function person(role: Role, held: { scope: string; role: Role }[] = []): Promise<string> {
  const created = await createUser({
    email: `person-${Math.random().toString(36).slice(2)}@example.com`,
    role,
    access: held.map(h => ({ tenantId: h.scope === '/' ? '' : TEST_TENANT_ID, scope: h.scope, role: h.role })),
  });
  if ('error' in created) throw new Error(created.error);
  return created.user.id;
}

const SCOPED = [{ scope: SUBSCRIPTION_A, role: 'editor' as const }];
const EVERYTHING = [{ scope: '/', role: 'editor' as const }];

function definition(name: string, overrides: Partial<PersonalRuleDefinition> = {}): PersonalRuleDefinition {
  return {
    name, description: 'Flags virtual machines', category: 'security', severity: 'high', queryBackend: 'resource-graph', kind: 'state',
    tags: ['vm'], scope: { level: 'subscription', subscriptions: [TEST_SUB_A] }, resourceTypes: [], conditions: [], rawKql: KQL,
    ...overrides,
  };
}

interface Cast {
  author: string;
  rule: PersonalRule;
  admin: string;
  reviewer: string;
  scoped: string;
  viewer: string;
  stranger: string;
}

let cast: Cast;
let castCounter = 0;

/** An author with a Personal rule, and one person of each kind that might meet the request. */
async function makeCast(name = 'VM rule'): Promise<Cast> {
  const author = await person('editor', SCOPED);
  return {
    author,
    rule: await createPersonalRule(author, definition(name)),
    admin: await person('admin'),
    reviewer: await person('editor', EVERYTHING),
    scoped: await person('editor', SCOPED),
    viewer: await person('viewer', [{ scope: SUBSCRIPTION_A, role: 'viewer' }]),
    stranger: await person('editor', SCOPED),
  };
}

/** The author sends the rule; returns the new request's id. */
async function sendRequest(rule: PersonalRule = cast.rule, author = cast.author, body?: unknown): Promise<string> {
  as(author);
  const res = await send(rule.id, body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const bodyOf = async <T = Record<string, unknown>>(res: Response): Promise<T> => (await res.json()) as T;
const auditActions = async () => (await listAllAuditEntries()).map(e => e.action);

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  vi.mocked(personalRun.limitedContext).mockClear();
  fakeCtx = fakeTenantContext();
  // Library rules outlive resetDb(), and a rule name is unique, so every test sends a rule of its own name.
  cast = await makeCast(`VM rule ${++castCounter}`);
});

describe('who may review a request', () => {
  it('refuses a Viewer and an Editor held at a smaller Scope with 403 on every reviewer route, and writes nothing', async () => {
    const id = await sendRequest();
    const rulesBefore = (await loadRules()).length;
    const auditBefore = (await listAllAuditEntries()).length;

    for (const refused of [cast.viewer, cast.scoped]) {
      as(refused);
      expect((await list()).status).toBe(403);
      expect((await view(id)).status).toBe(403);
      expect((await preview(id)).status).toBe(403);
      expect((await approve(id, { name: 'Taken by nobody' })).status).toBe(403);
      expect((await reject(id, { reason: 'No' })).status).toBe(403);
    }

    expect((await getLibraryRequest(id))!.status).toBe('open');
    expect((await loadRules()).length).toBe(rulesBefore);
    expect((await listAllAuditEntries()).length).toBe(auditBefore);
    expect(fakeCtx.queries).toEqual([]);
  });

  it('lets an Admin and an Editor on Everything list, read and preview a request', async () => {
    const id = await sendRequest();

    for (const reviewer of [cast.admin, cast.reviewer]) {
      as(reviewer);
      const listed = await bodyOf<{ count: number; requests: { id: string; name: string }[] }>(await list());
      expect(listed.count).toBe(1);
      expect(listed.requests.map(r => r.id)).toEqual([id]);

      const read = await view(id);
      expect(read.status).toBe(200);
      expect(await bodyOf(read)).toMatchObject({
        id, status: 'open', name: cast.rule.name, kql: KQL,
        definition: { scope: { level: 'subscription', subscriptions: [TEST_SUB_A] } },
        author: { id: cast.author },
      });
      expect((await preview(id)).status).toBe(200);
    }
  });

  it('answers 404 for a request that does not exist', async () => {
    as(cast.admin);
    expect((await view('00000000-0000-0000-0000-0000000000ff')).status).toBe(404);
    expect((await approve('00000000-0000-0000-0000-0000000000ff')).status).toBe(404);
    expect((await reject('00000000-0000-0000-0000-0000000000ff', { reason: 'x' })).status).toBe(404);
  });

  it('generates the query of a visual rule from its conditions, and says a Graph rule has none', async () => {
    const author = await person('editor', [...SCOPED, { scope: '@directory', role: 'editor' }]);
    const visual = await createPersonalRule(author, definition('Visual', {
      rawKql: undefined, resourceTypes: ['microsoft.compute/virtualmachines'],
      conditions: [{ id: 'c1', field: 'location', operator: 'equals', value: 'westeurope' }] as never,
    }));
    const graph = await createPersonalRule(author, definition('Graph', {
      queryBackend: 'microsoft-graph', rawKql: undefined, graphQuery: { path: 'users', filter: 'accountEnabled eq false' } as never,
    }));
    const visualId = await sendRequest(visual, author);
    const graphId = await sendRequest(graph, author);

    as(cast.admin);
    expect((await bodyOf<{ kql: string }>(await view(visualId))).kql).toContain('westeurope');
    expect(await bodyOf(await view(graphId))).toMatchObject({ kql: null, definition: { graphQuery: { path: 'users' } } });
  });
});

describe('the author', () => {
  it('sends their own rule, and the request keeps the rule as it was sent', async () => {
    const id = await sendRequest();
    as(cast.author);
    await updatePersonalRule(cast.rule.id, cast.author, definition('Renamed after sending', { rawKql: `${KQL} | take 3` }));

    as(cast.admin);
    expect(await bodyOf(await view(id))).toMatchObject({ name: cast.rule.name, kql: KQL });
  });

  it('is told 404 when sending, withdrawing or reading the requests of someone else\'s Personal rule', async () => {
    const id = await sendRequest();

    for (const other of [cast.stranger, cast.admin, cast.reviewer]) {
      as(other);
      expect((await send(cast.rule.id)).status).toBe(404);
      expect((await withdraw(id)).status).toBe(404);
      expect((await readPersonal(cast.rule.id)).status).toBe(404);
    }
    expect((await getLibraryRequest(id))!.status).toBe('open');
    expect(await listLibraryRequestsForPersonalRule(cast.rule.id, cast.author)).toHaveLength(1);
  });

  it('refuses a second request while one is open, with 409', async () => {
    await sendRequest();
    as(cast.author);
    const again = await send(cast.rule.id);
    expect(again.status).toBe(409);
    expect(await countRows('library_requests')).toBe(1);
  });

  it('withdraws their own open request, and cannot withdraw a closed one', async () => {
    const id = await sendRequest();
    as(cast.author);
    expect((await withdraw(id)).status).toBe(200);
    expect((await getLibraryRequest(id))!.status).toBe('withdrawn');
    expect((await withdraw(id)).status).toBe(409);

    const approvedId = await sendRequest();
    as(cast.admin);
    expect((await approve(approvedId)).status).toBe(201);
    as(cast.author);
    expect((await withdraw(approvedId)).status).toBe(409);
    expect((await getLibraryRequest(approvedId))!.status).toBe('approved');
  });

  it('may send a rule again once an earlier request was withdrawn', async () => {
    const first = await sendRequest();
    as(cast.author);
    await withdraw(first);
    const second = await sendRequest();
    expect(second).not.toBe(first);
  });

  it('reads the history of the rule\'s requests on the rule: status, reason and the library rule it became', async () => {
    const rejected = await sendRequest();
    as(cast.admin);
    await reject(rejected, { reason: 'Name it after the control it checks.' });
    const approvedId = await sendRequest(cast.rule, cast.author, { resubmits: rejected });
    as(cast.admin);
    const approved = await bodyOf<{ rule: { id: string } }>(await approve(approvedId, { name: 'VM baseline' }));

    as(cast.author);
    const read = await bodyOf<{ libraryRequests: { id: string; status: string; rejectionReason?: string; libraryRule?: { id: string; name: string } }[] }>(await readPersonal(cast.rule.id));
    expect(read.libraryRequests.map(r => r.status)).toEqual(['approved', 'rejected']);
    const [newest, oldest] = read.libraryRequests;
    expect(newest!.libraryRule).toEqual({ id: approved.rule.id, name: 'VM baseline' });
    expect(oldest!.rejectionReason).toBe('Name it after the control it checks.');
    expect(JSON.stringify(read)).not.toContain(cast.admin);
  });

  it('refuses a Viewer who was an Editor, on send and withdraw', async () => {
    const id = await sendRequest();
    const { updateUserRole } = await import('@/lib/db/users');
    await updateUserRole(cast.author, 'viewer');
    as(cast.author);
    expect((await send(cast.rule.id)).status).toBe(403);
    expect((await withdraw(id)).status).toBe(403);
  });
});

describe('approving', () => {
  it('creates a custom library rule under a new id with the reviewer\'s edits, and records the request', async () => {
    const id = await sendRequest();
    as(cast.reviewer);
    const res = await approve(id, {
      name: 'Approved VM rule', category: 'cost', severity: 'low', enabled: true,
      scope: { level: 'subscription', subscriptions: [TEST_SUB_A, '22222222-2222-2222-2222-222222222222'] },
    });
    expect(res.status).toBe(201);
    const { rule } = await bodyOf<{ rule: { id: string } }>(res);

    expect(rule.id).not.toBe(cast.rule.id);
    expect(rule.id).not.toBe(id);
    expect(await loadRule(rule.id)).toMatchObject({
      type: 'custom', name: 'Approved VM rule', category: 'cost', severity: 'low', enabled: true, libraryRequestId: id,
      scope: { level: 'subscription', subscriptions: [TEST_SUB_A, '22222222-2222-2222-2222-222222222222'] },
      rawKql: KQL, description: 'Flags virtual machines', tags: ['vm'], queryBackend: 'resource-graph',
    });
  });

  it('starts the rule disabled unless the reviewer turns it on', async () => {
    const id = await sendRequest();
    as(cast.admin);
    const { rule } = await bodyOf<{ rule: { id: string } }>(await approve(id));
    expect((await loadRule(rule.id))!.enabled).toBe(false);
  });

  it('closes the request with the reviewer and the time, and leaves the Personal rule pointing at the new rule', async () => {
    const id = await sendRequest();
    as(cast.admin);
    const { rule } = await bodyOf<{ rule: { id: string } }>(await approve(id));

    expect(await getLibraryRequest(id)).toMatchObject({ status: 'approved', reviewedBy: cast.admin, libraryRuleId: rule.id });
    expect((await getLibraryRequest(id))!.reviewedAt).toBeTruthy();
    const personal = await getPersonalRule(cast.rule.id, cast.author);
    expect(personal).not.toBeNull();
    expect(personal!.libraryRuleId).toBe(rule.id);
  });

  it('takes every field but the five from the snapshot, whatever the body carries', async () => {
    const id = await sendRequest();
    as(cast.admin);
    const { rule } = await bodyOf<{ rule: { id: string } }>(await approve(id, {
      name: 'Only these five', type: 'builtin', pack: 'aprl-v2', version: '9', rawKql: 'resources | project id', description: 'Rewritten',
      tags: ['other'], libraryRequestId: 'not-mine', originRuleId: 'x', id: 'chosen-by-client', lastRunStatus: 'success',
    }));

    const stored = (await loadRule(rule.id))!;
    expect(stored).toMatchObject({ name: 'Only these five', type: 'custom', rawKql: KQL, description: 'Flags virtual machines', tags: ['vm'], libraryRequestId: id });
    expect(stored.id).not.toBe('chosen-by-client');
    expect(stored.pack).toBeUndefined();
    expect(stored.version).toBeUndefined();
    expect(stored.originRuleId).toBeUndefined();
    expect(stored.lastRunStatus).toBeUndefined();
  });

  it('answers 409 for a name that differs only in case from a library rule, writes no rule and leaves the request open', async () => {
    const other = await createPersonalRule(cast.author, definition('Existing in library'));
    const firstId = await sendRequest(other);
    as(cast.admin);
    await approve(firstId, { name: 'Existing in library' });
    const rulesBefore = (await loadRules()).length;

    const id = await sendRequest();
    as(cast.admin);
    const res = await approve(id, { name: 'EXISTING IN LIBRARY' });
    expect(res.status).toBe(409);
    expect((await bodyOf<{ error: string }>(res)).error).toContain('EXISTING IN LIBRARY');
    expect((await loadRules()).length).toBe(rulesBefore);
    expect((await getLibraryRequest(id))!.status).toBe('open');
    expect((await getPersonalRule(cast.rule.id, cast.author))!.libraryRuleId).toBeUndefined();
  });

  it('refuses a request that is not open, whatever closed it', async () => {
    const withdrawn = await sendRequest();
    as(cast.author);
    await withdraw(withdrawn);
    const rejected = await sendRequest();
    as(cast.admin);
    await reject(rejected, { reason: 'Not now.' });
    const approved = await sendRequest();
    as(cast.admin);
    await approve(approved, { name: 'Approved once' });
    const rulesBefore = (await loadRules()).length;

    for (const closed of [withdrawn, rejected, approved]) {
      as(cast.admin);
      expect((await approve(closed, { name: `Again ${closed}` })).status).toBe(409);
      expect((await reject(closed, { reason: 'Too late' })).status).toBe(409);
    }
    expect((await loadRules()).length).toBe(rulesBefore);
    expect((await getLibraryRequest(rejected))!.status).toBe('rejected');
    expect((await getLibraryRequest(approved))!.status).toBe('approved');
  });

  it('answers 400 for a category that does not exist, a blank name or an edit of the wrong type, and stays open', async () => {
    const id = await sendRequest();
    as(cast.admin);
    expect((await approve(id, { category: 'no-such-category' })).status).toBe(400);
    expect((await approve(id, { name: '   ' })).status).toBe(400);
    expect((await approve(id, { severity: 'catastrophic' })).status).toBe(400);
    expect((await approve(id, { enabled: 'yes' })).status).toBe(400);
    expect((await approve(id, { scope: 'everything' })).status).toBe(400);
    expect((await getLibraryRequest(id))!.status).toBe('open');
    expect(await countRows('library_requests')).toBe(1);
  });

  it('holds the approved definition to the checks a rule created in the Library meets', async () => {
    const author = await person('editor', SCOPED);
    const hollow = await createPersonalRule(author, definition('Matches everything', {
      rawKql: undefined, visualQuery: { stages: [] } as never,
    }));
    const id = await sendRequest(hollow, author);
    as(cast.admin);
    const res = await approve(id);
    expect(res.status).toBe(400);
    expect((await getLibraryRequest(id))!.status).toBe('open');
  });
});

describe('rejecting', () => {
  it('needs a reason: none, an empty one or only spaces answers 400 and leaves the request open', async () => {
    const id = await sendRequest();
    as(cast.admin);
    expect((await reject(id)).status).toBe(400);
    expect((await reject(id, {})).status).toBe(400);
    expect((await reject(id, { reason: '' })).status).toBe(400);
    expect((await reject(id, { reason: '  \n\t ' })).status).toBe(400);
    expect((await reject(id, { reason: 7 })).status).toBe(400);
    expect((await getLibraryRequest(id))!.status).toBe('open');
  });

  it('closes the request with the reviewer, the time and the reason the author reads', async () => {
    const id = await sendRequest();
    const rulesBefore = (await loadRules()).length;
    as(cast.reviewer);
    expect((await reject(id, { reason: '  Scope it to production first.  ' })).status).toBe(200);

    expect(await getLibraryRequest(id)).toMatchObject({ status: 'rejected', reviewedBy: cast.reviewer, rejectionReason: 'Scope it to production first.' });
    as(cast.author);
    const read = await bodyOf<{ libraryRequests: { rejectionReason?: string }[] }>(await readPersonal(cast.rule.id));
    expect(read.libraryRequests[0]!.rejectionReason).toBe('Scope it to production first.');
    expect((await loadRules()).length).toBe(rulesBefore);
  });
});

describe('resubmitting', () => {
  it('sends a rejected request again as a new open request that names it', async () => {
    const first = await sendRequest();
    as(cast.admin);
    await reject(first, { reason: 'Try again.' });

    const second = await sendRequest(cast.rule, cast.author, { resubmits: first });
    expect(await getLibraryRequest(second)).toMatchObject({ status: 'open', resubmitsRequestId: first });
    expect((await getLibraryRequest(first))!.status).toBe('rejected');
  });

  it('refuses to resubmit an open or an approved request, with 409', async () => {
    const open = await sendRequest();
    as(cast.author);
    expect((await send(cast.rule.id, { resubmits: open })).status).toBe(409);

    as(cast.admin);
    await approve(open, { name: 'Went in' });
    as(cast.author);
    expect((await send(cast.rule.id, { resubmits: open })).status).toBe(409);
    expect(await countRows('library_requests')).toBe(1);
  });

  it('refuses to resubmit someone else\'s request, or a request for another of the author\'s rules, with 404', async () => {
    const theirs = await sendRequest();
    as(cast.admin);
    await reject(theirs, { reason: 'No.' });

    const strangerRule = await createPersonalRule(cast.stranger, definition('Stranger rule'));
    as(cast.stranger);
    expect((await send(strangerRule.id, { resubmits: theirs })).status).toBe(404);

    const otherRule = await createPersonalRule(cast.author, definition('Another rule of the author'));
    as(cast.author);
    expect((await send(otherRule.id, { resubmits: theirs })).status).toBe(404);
    expect((await send(cast.rule.id, { resubmits: '00000000-0000-0000-0000-0000000000ff' })).status).toBe(404);
    expect(await countRows('library_requests')).toBe(1);
  });

  it('answers 400 for a resubmits that is not an id', async () => {
    as(cast.author);
    expect((await send(cast.rule.id, { resubmits: 12 })).status).toBe(400);
    expect((await send(cast.rule.id, { resubmits: '' })).status).toBe(400);
    expect(await countRows('library_requests')).toBe(0);
  });
});

describe('the preview', () => {
  const counts = async () => ({
    findings: await countRows('findings'), scanFindings: await countRows('scan_findings'), scans: await countRows('scans'),
    results: await countRows('personal_rule_results'), requests: await countRows('library_requests'), rules: (await loadRules()).length,
  });

  it('returns the results and stores nothing: no finding, scan, personal result, rule or last-run field', async () => {
    as(cast.author);
    await replacePersonalRuleResults(cast.rule.id, cast.author, {
      status: 'success', ranAt: '2026-01-01T00:00:00.000Z', coveredScope: '[]',
      results: [{ severity: 'low', title: 'earlier', rows: [] }],
    });
    const id = await sendRequest();
    fakeCtx = fakeTenantContext({ rows: [argRow({ name: 'vm-preview' })] });
    const rulesBefore = JSON.stringify(await loadRules());
    const personalBefore = await getPersonalRule(cast.rule.id, cast.author);
    const before = await counts();

    as(cast.reviewer);
    const res = await preview(id);
    expect(res.status).toBe(200);
    const body = await bodyOf<{ status: string; results: { resourceName: string }[] }>(res);
    expect(body.status).toBe('success');
    expect(body.results.map(r => r.resourceName)).toEqual(['vm-preview']);

    expect(await counts()).toEqual(before);
    expect(JSON.stringify(await loadRules())).toBe(rulesBefore);
    expect(await getPersonalRule(cast.rule.id, cast.author)).toEqual(personalBefore);
    expect((await getLibraryRequest(id))!.status).toBe('open');
  });

  it('asks Resource Graph through the limited context, over the scope the reviewer is trying', async () => {
    const id = await sendRequest();
    as(cast.reviewer);
    await preview(id, { scope: { level: 'subscription', subscriptions: [TEST_SUB_A] } });

    expect(personalRun.limitedContext).toHaveBeenCalledTimes(1);
    expect(vi.mocked(personalRun.limitedContext).mock.calls[0]![0]).toBe(fakeCtx);
    expect(fakeCtx.queries.length).toBeGreaterThan(0);
    for (const q of fakeCtx.queries) expect(q.scope).toEqual({ subscriptions: [TEST_SUB_A] });
  });

  it('runs the snapshot, not the Personal rule as it is now', async () => {
    const id = await sendRequest();
    as(cast.author);
    await updatePersonalRule(cast.rule.id, cast.author, definition('Edited', { rawKql: 'resources | where name == "edited" | project id, name, type, location, resourceGroup, subscriptionId' }));

    as(cast.admin);
    await preview(id);
    expect(fakeCtx.queries.some(q => q.kql.includes('edited'))).toBe(false);
    expect(fakeCtx.queries.some(q => q.kql.includes('microsoft.compute/virtualmachines'))).toBe(true);
  });

  it('says why when the query fails, and never returns the Azure error', async () => {
    const id = await sendRequest();
    fakeCtx = fakeTenantContext({ failWith: new Error('AADSTS7000215 tenant 00000000-0000-0000-0000-00000000dead') });
    as(cast.admin);
    const res = await preview(id);
    const body = await bodyOf<{ status?: string; error?: string }>(res);
    expect(JSON.stringify(body)).not.toContain('dead');
    expect(JSON.stringify(body)).not.toContain('AADSTS');
  });

  it('refuses a request that is no longer open', async () => {
    const id = await sendRequest();
    as(cast.admin);
    await reject(id, { reason: 'No.' });
    expect((await preview(id)).status).toBe(409);
  });
});

describe('copying straight to the library', () => {
  it('lets an Admin copy their own Personal rule, with a new id, no request and the Personal rule pointing at it', async () => {
    const mine = await createPersonalRule(cast.admin, definition('Admin rule'));
    as(cast.admin);
    const res = await copyToLibrary(mine.id);
    expect(res.status).toBe(201);
    const rule = await bodyOf<{ id: string }>(res);

    expect(rule.id).not.toBe(mine.id);
    expect(await loadRule(rule.id)).toMatchObject({ type: 'custom', name: 'Admin rule', rawKql: KQL, libraryRequestId: undefined });
    expect((await getPersonalRule(mine.id, cast.admin))!.libraryRuleId).toBe(rule.id);
    expect(await countRows('library_requests')).toBe(0);
  });

  it('lets an Editor on Everything copy their own rule', async () => {
    const mine = await createPersonalRule(cast.reviewer, definition('Reviewer rule'));
    as(cast.reviewer);
    expect((await copyToLibrary(mine.id)).status).toBe(201);
  });

  it('refuses an Editor held at a smaller Scope with 403 and the reason, and writes no rule', async () => {
    const rulesBefore = (await loadRules()).length;
    as(cast.author);
    const res = await copyToLibrary(cast.rule.id);
    expect(res.status).toBe(403);
    expect((await bodyOf<{ error: string }>(res)).error).toBe(COPY_TO_LIBRARY_REASON);
    expect((await loadRules()).length).toBe(rulesBefore);
  });

  it('answers 404 for another person\'s rule, an Admin included', async () => {
    as(cast.admin);
    expect((await copyToLibrary(cast.rule.id)).status).toBe(404);
    as(cast.reviewer);
    expect((await copyToLibrary(cast.rule.id)).status).toBe(404);
  });

  it('answers 409 for a name that is taken, ignoring case, and writes no rule', async () => {
    const first = await createPersonalRule(cast.admin, definition('Shared name'));
    const second = await createPersonalRule(cast.admin, definition('SHARED NAME'));
    as(cast.admin);
    expect((await copyToLibrary(first.id)).status).toBe(201);
    const rulesBefore = (await loadRules()).length;
    expect((await copyToLibrary(second.id)).status).toBe(409);
    expect((await loadRules()).length).toBe(rulesBefore);
    expect((await getPersonalRule(second.id, cast.admin))!.libraryRuleId).toBeUndefined();
  });
});

describe('deleting', () => {
  it('a Personal rule withdraws its open request and keeps the closed ones as history', async () => {
    const rejected = await sendRequest();
    as(cast.admin);
    await reject(rejected, { reason: 'No.' });
    const open = await sendRequest(cast.rule, cast.author, { resubmits: rejected });

    as(cast.author);
    expect((await personalItem.DELETE(empty('DELETE'), idParams(cast.rule.id))).status).toBe(200);

    expect(await getLibraryRequest(open)).toMatchObject({ status: 'withdrawn', personalRuleId: undefined });
    expect(await getLibraryRequest(rejected)).toMatchObject({ status: 'rejected', personalRuleId: undefined });
    expect(await auditActions()).toContain('library_request.withdraw');
    expect(await listPersonalRules(cast.author)).toEqual([]);
  });

  it('the library rule clears the link on the Personal rule, which stays', async () => {
    const id = await sendRequest();
    as(cast.admin);
    const { rule } = await bodyOf<{ rule: { id: string } }>(await approve(id));
    const { deleteRule } = await import('@/lib/rules');
    expect(await deleteRule(rule.id)).toBe(true);

    const personal = await getPersonalRule(cast.rule.id, cast.author);
    expect(personal).not.toBeNull();
    expect(personal!.libraryRuleId).toBeUndefined();
  });
});

describe('the audit log', () => {
  it('holds one entry for each request, approval, rejection, withdrawal, preview and direct copy', async () => {
    const approvedId = await sendRequest();
    const rejectedId = await sendRequest(await createPersonalRule(cast.author, definition('Second rule')));
    const withdrawnId = await sendRequest(await createPersonalRule(cast.author, definition('Third rule')));
    as(cast.admin);
    await preview(approvedId);
    await approve(approvedId, { name: 'Audited approval' });
    await reject(rejectedId, { reason: 'A private reason the log must not carry.' });
    as(cast.author);
    await withdraw(withdrawnId);
    const mine = await createPersonalRule(cast.admin, definition('Admin copy'));
    as(cast.admin);
    await copyToLibrary(mine.id);

    const actions = await auditActions();
    const count = (action: string) => actions.filter(a => a === action).length;
    expect(count('library_request.create')).toBe(3);
    expect(count('library_request.preview')).toBe(1);
    expect(count('library_request.approve')).toBe(1);
    expect(count('library_request.reject')).toBe(1);
    expect(count('library_request.withdraw')).toBe(1);
    expect(count('personal_rule.library_copy')).toBe(1);
  });

  it('names fields and ids, never the query or the reason a reviewer wrote', async () => {
    const id = await sendRequest();
    as(cast.admin);
    await preview(id);
    await reject(id, { reason: 'A private reason the log must not carry.' });

    const text = JSON.stringify((await listAllAuditEntries()).filter(e => e.action.startsWith('library_request.')));
    expect(text).not.toContain('private reason');
    expect(text).not.toContain('microsoft.compute');
    expect(text).toContain(id);
  });
});

describe('removing the author', () => {
  it('withdraws their open requests with the removal, and the removal is audited with the count', async () => {
    const open = await sendRequest();
    const second = await sendRequest(await createPersonalRule(cast.author, definition('Second open rule')));
    const rejected = await sendRequest(await createPersonalRule(cast.author, definition('Rejected rule')));
    as(cast.admin);
    await reject(rejected, { reason: 'Not yet.' });

    const res = await usersItem.DELETE(empty('DELETE'), idParams(cast.author));
    expect(res.status).toBe(200);

    expect((await getLibraryRequest(open))!.status).toBe('withdrawn');
    expect((await getLibraryRequest(second))!.status).toBe('withdrawn');
    expect((await getLibraryRequest(rejected))!.status).toBe('rejected');
    const entries = await listAllAuditEntries();
    expect(entries.filter(e => e.action === 'user.remove')).toHaveLength(1);
    const withdrawals = entries.filter(e => e.action === 'library_request.withdraw');
    expect(withdrawals).toHaveLength(1);
    expect(withdrawals[0]!.details).toMatchObject({ withdrawn: 2 });
    expect(await listPersonalRules(cast.author)).toEqual([]);
  });

  it('writes no withdrawal entry when the person had no open request', async () => {
    as(cast.admin);
    expect((await usersItem.DELETE(empty('DELETE'), idParams(cast.stranger))).status).toBe(200);
    expect(await auditActions()).not.toContain('library_request.withdraw');
  });
});

describe('the repository holds the rules even when a route is bypassed', () => {
  it('refuses to approve a request that closed after the route read it, and writes no rule', async () => {
    const id = await sendRequest();
    await rejectLibraryRequest(id, cast.admin, 'Closed first.');
    const rulesBefore = (await loadRules()).length;

    expect(await approveLibraryRequest(id, cast.reviewer, { name: 'Too late' })).toEqual({ ok: false, reason: 'not-open' });
    expect(await approveLibraryRequest('00000000-0000-0000-0000-0000000000ff', cast.reviewer, {})).toEqual({ ok: false, reason: 'not-found' });
    expect((await loadRules()).length).toBe(rulesBefore);
    expect((await getLibraryRequest(id))!.status).toBe('rejected');
    expect(await rejectLibraryRequest(id, cast.reviewer, 'Again')).toEqual({ ok: false, reason: 'not-open' });
  });

  it('accepts a resubmission only from the author of the rejected request', async () => {
    const theirs = await createLibraryRequest(cast.rule, cast.stranger);
    if (!theirs.ok) throw new Error(theirs.reason);
    await rejectLibraryRequest(theirs.request.id, cast.admin, 'No.');

    expect(await createLibraryRequest(cast.rule, cast.author, theirs.request.id)).toEqual({ ok: false, reason: 'resubmit-not-found' });
    expect(await createLibraryRequest(cast.rule, cast.stranger, theirs.request.id)).toMatchObject({ ok: true });
  });
});

describe('update requests', () => {
  const NEW_KQL = `${KQL} | where location == "westeurope"`;
  let ruleCounter = 0;

  /** A custom library rule, as the library holds one: a unique name, since library rules outlive resetDb(). */
  async function libraryRule(overrides: Record<string, unknown> = {}): Promise<Rule> {
    const made = await createRule({
      id: `update-target-${++ruleCounter}-${castCounter}`, type: 'custom', name: `Library VM rule ${castCounter}-${ruleCounter}`,
      description: 'Flags virtual machines', category: 'security', severity: 'high', enabled: false, queryBackend: 'resource-graph', kind: 'state',
      scope: { level: 'subscription', subscriptions: [TEST_SUB_A] }, resourceTypes: [], conditions: [], rawKql: KQL,
      ...overrides,
    } as unknown as Rule);
    if (!made.ok) throw new Error(made.reason);
    return made.rule;
  }

  /** A Personal rule copied from `source`, as the Copy to personal route leaves it. */
  const copyOf = (source: Rule, overrides: Partial<PersonalRuleDefinition> = {}) =>
    createPersonalRule(cast.author, definition(`Copy of ${source.name}`, overrides), source.id);

  /** The Personal rule is sent as an update to its custom source, and the answer is the request id. */
  async function sendUpdate(personal: PersonalRule, target: Rule, extra: Record<string, unknown> = {}): Promise<string> {
    return sendRequest(personal, cast.author, { updates: target.id, ...extra });
  }

  const readDetail = async (id: string) => {
    as(cast.reviewer);
    const res = await view(id);
    expect(res.status).toBe(200);
    return bodyOf<{
      target?: { id: string; name: string } | null; targetChanged?: boolean; diff?: { kind: string; text: string }[]; isUpdate?: boolean;
    }>(res);
  };

  const putTarget = async (target: Rule, changes: Record<string, unknown>) => {
    as(cast.admin);
    const res = await rulesItem.PUT(jsonRequest('PUT', {
      name: target.name, description: target.description, category: target.category, severity: target.severity,
      enabled: target.enabled, scope: target.scope, resourceTypes: [], conditions: [], rawKql: target.rawKql, ...changes,
    }), idParams(target.id));
    expect(res.status).toBe(200);
  };

  describe('choosing the target', () => {
    it('records the library rule the Personal rule made, and a snapshot of its definition', async () => {
      const first = await sendRequest();
      as(cast.admin);
      const { rule } = await bodyOf<{ rule: { id: string } }>(await approve(first, { name: `Made by ${first}` }));
      const second = await sendRequest(cast.rule, cast.author, { updates: rule.id });

      expect(await getLibraryRequest(second)).toMatchObject({
        status: 'open', targetRuleId: rule.id,
        targetDefinition: { name: `Made by ${first}`, category: 'security', severity: 'high', rawKql: KQL },
      });
    });

    it('records a custom source rule as the target', async () => {
      const source = await libraryRule();
      const personal = await copyOf(source);
      const id = await sendUpdate(personal, source);
      expect(await getLibraryRequest(id)).toMatchObject({
        status: 'open', targetRuleId: source.id, targetDefinition: { name: source.name, rawKql: KQL },
      });
      expect(await getLibraryRequest(id)).toMatchObject({ definition: { name: personal.name } });
    });

    it('answers 400 for a built-in target and writes no request', async () => {
      const builtin = (await loadRules()).find(r => r.type === 'builtin' && (r.queryBackend ?? 'resource-graph') === 'resource-graph')!;
      const personal = await copyOf(builtin);
      as(cast.author);
      const res = await send(personal.id, { updates: builtin.id });
      expect(res.status).toBe(400);
      expect((await bodyOf<{ error: string }>(res)).error).toContain('can only be sent as a new rule');
      expect(await countRows('library_requests')).toBe(0);
    });

    it('answers 404 for a rule that is neither the library rule nor the source of this one, and writes no request', async () => {
      const unrelated = await libraryRule();
      as(cast.author);
      expect((await send(cast.rule.id, { updates: unrelated.id })).status).toBe(404);
      expect((await send(cast.rule.id, { updates: '00000000-0000-0000-0000-0000000000ff' })).status).toBe(404);
      expect(await countRows('library_requests')).toBe(0);
    });

    it('answers 400 for an updates that is not an id', async () => {
      as(cast.author);
      expect((await send(cast.rule.id, { updates: 12 })).status).toBe(400);
      expect((await send(cast.rule.id, { updates: '' })).status).toBe(400);
      expect(await countRows('library_requests')).toBe(0);
    });

    it('answers 400 for a target on another query backend', async () => {
      const graph = await libraryRule({ queryBackend: 'microsoft-graph', rawKql: undefined, graphQuery: { path: 'users', filter: 'accountEnabled eq false' } });
      const personal = await copyOf(graph);
      as(cast.author);
      expect((await send(personal.id, { updates: graph.id })).status).toBe(400);
      expect(await countRows('library_requests')).toBe(0);
    });

    it('keeps the target when a rejected update request is sent again', async () => {
      const source = await libraryRule();
      const personal = await copyOf(source);
      const first = await sendUpdate(personal, source);
      as(cast.admin);
      await reject(first, { reason: 'Try again.' });

      const second = await sendRequest(personal, cast.author, { resubmits: first });
      expect(await getLibraryRequest(second)).toMatchObject({ resubmitsRequestId: first, targetRuleId: source.id, targetDefinition: { name: source.name } });
    });

    it('can be sent again as an update after an earlier request was approved', async () => {
      const source = await libraryRule();
      const personal = await copyOf(source);
      const first = await sendUpdate(personal, source);
      as(cast.admin);
      expect((await approve(first)).status).toBe(201);
      const second = await sendUpdate(personal, source);
      expect(second).not.toBe(first);
    });

    it('audits the send once, with the target id and no query', async () => {
      const source = await libraryRule();
      const personal = await copyOf(source);
      const id = await sendUpdate(personal, source);
      const sends = (await listAllAuditEntries()).filter(e => e.action === 'library_request.create');
      expect(sends).toHaveLength(1);
      expect(sends[0]).toMatchObject({ entityId: id, details: { targetRuleId: source.id, update: true } });
      expect(JSON.stringify(sends[0])).not.toContain('virtualmachines');
    });
  });

  describe('what the reviewer reads', () => {
    it('shows the target, a line diff against it, and no change flag while the target is as it was', async () => {
      const source = await libraryRule();
      const personal = await copyOf(source, { rawKql: NEW_KQL, severity: 'low' });
      const id = await sendUpdate(personal, source);

      const detail = await readDetail(id);
      expect(detail.target).toEqual({ id: source.id, name: source.name });
      expect(detail.targetChanged).toBe(false);
      expect(detail.diff).toContainEqual({ kind: 'removed', text: 'Severity: high' });
      expect(detail.diff).toContainEqual({ kind: 'added', text: 'Severity: low' });
      expect(detail.diff).toContainEqual({ kind: 'added', text: NEW_KQL });
      expect(detail.diff).toContainEqual({ kind: 'removed', text: KQL });
      expect(detail.diff).toContainEqual({ kind: 'same', text: 'Category: security' });
    });

    it('says the target changed once it is edited, and diffs against the edited rule', async () => {
      const source = await libraryRule();
      const personal = await copyOf(source, { rawKql: NEW_KQL });
      const id = await sendUpdate(personal, source);
      await putTarget(source, { description: 'Edited by someone else' });

      const detail = await readDetail(id);
      expect(detail.targetChanged).toBe(true);
      expect(detail.diff).toContainEqual({ kind: 'removed', text: 'Description: Edited by someone else' });
      expect(detail.diff).toContainEqual({ kind: 'added', text: 'Description: Flags virtual machines' });
    });

    it('flags a change to the query alone', async () => {
      const source = await libraryRule();
      const id = await sendUpdate(await copyOf(source), source);
      await putTarget(source, { rawKql: NEW_KQL });
      expect((await readDetail(id)).targetChanged).toBe(true);
    });

    it('has no target, no diff and no flag on a new-rule request', async () => {
      const detail = await readDetail(await sendRequest());
      expect(detail.target).toBeUndefined();
      expect(detail.diff).toBeUndefined();
      expect(detail.targetChanged).toBeUndefined();
    });

    it('lists the request with its target, and names the target to the author', async () => {
      const source = await libraryRule();
      const personal = await copyOf(source);
      const id = await sendUpdate(personal, source);

      as(cast.reviewer);
      const listed = await bodyOf<{ requests: { id: string; isUpdate?: boolean; target?: { id: string; name: string } | null }[] }>(await list());
      expect(listed.requests.find(r => r.id === id)).toMatchObject({ isUpdate: true, target: { id: source.id, name: source.name } });

      as(cast.author);
      const read = await bodyOf<{ libraryRequests: { id: string; isUpdate?: boolean; target?: { id: string; name: string } | null }[] }>(await readPersonal(personal.id));
      expect(read.libraryRequests[0]).toMatchObject({ id, isUpdate: true, target: { id: source.id, name: source.name } });
    });

    it('reads target as null once the rule is gone, and no flag or diff', async () => {
      const source = await libraryRule();
      const id = await sendUpdate(await copyOf(source), source);
      await deleteRule(source.id);

      const detail = await readDetail(id);
      expect(detail.target).toBeNull();
      expect(detail.targetChanged).toBe(false);
      expect(detail.diff).toEqual([]);
    });
  });

  describe('approving', () => {
    it('edits the target in place: same id, same rule count, the reviewed definition', async () => {
      const source = await libraryRule({ enabled: true });
      const personal = await copyOf(source, { rawKql: NEW_KQL, severity: 'low', description: 'A better description' });
      const id = await sendUpdate(personal, source);
      const count = (await loadRules()).length;

      as(cast.reviewer);
      const res = await approve(id, { name: `${source.name} renamed`, category: 'cost' });
      expect(res.status).toBe(201);
      expect((await bodyOf<{ rule: { id: string } }>(res)).rule.id).toBe(source.id);

      expect((await loadRules()).length).toBe(count);
      expect(await loadRule(source.id)).toMatchObject({
        id: source.id, type: 'custom', name: `${source.name} renamed`, category: 'cost', severity: 'low', rawKql: NEW_KQL,
        description: 'A better description', queryBackend: 'resource-graph',
      });
      expect(await getLibraryRequest(id)).toMatchObject({ status: 'approved', reviewedBy: cast.reviewer, libraryRuleId: source.id });
      expect((await getPersonalRule(personal.id, cast.author))!.libraryRuleId).toBe(source.id);
    });

    it('keeps the target\'s enabled state unless the reviewer sets it', async () => {
      const on = await libraryRule({ enabled: true });
      const off = await libraryRule({ enabled: false });
      const onRequest = await sendUpdate(await copyOf(on), on);
      const offRequest = await sendUpdate(await copyOf(off), off);

      as(cast.admin);
      expect((await approve(onRequest)).status).toBe(201);
      expect((await approve(offRequest, { enabled: true })).status).toBe(201);
      expect((await loadRule(on.id))!.enabled).toBe(true);
      expect((await loadRule(off.id))!.enabled).toBe(true);
    });

    it('lets the reviewer turn the target off', async () => {
      const on = await libraryRule({ enabled: true });
      const id = await sendUpdate(await copyOf(on), on);
      as(cast.admin);
      expect((await approve(id, { enabled: false })).status).toBe(201);
      expect((await loadRule(on.id))!.enabled).toBe(false);
    });

    it('leaves what a request cannot write as it was: type, pack, backend, request id and run outcome', async () => {
      const source = await libraryRule({ libraryRequestId: 'earlier-request', lastRunStatus: 'success', lastRunAt: '2026-01-01T00:00:00.000Z' });
      const id = await sendUpdate(await copyOf(source), source);
      as(cast.admin);
      await approve(id, { type: 'builtin', pack: 'aprl-v2', libraryRequestId: id, queryBackend: 'microsoft-graph' });
      expect(await loadRule(source.id)).toMatchObject({
        type: 'custom', queryBackend: 'resource-graph', libraryRequestId: 'earlier-request', lastRunStatus: 'success', lastRunAt: '2026-01-01T00:00:00.000Z',
      });
    });

    it('answers 409 for a name that clashes in another case, changes nothing and leaves the request open', async () => {
      const source = await libraryRule();
      const other = await libraryRule();
      const id = await sendUpdate(await copyOf(source, { rawKql: NEW_KQL }), source);
      const before = JSON.stringify(await loadRule(source.id));
      const count = (await loadRules()).length;

      as(cast.admin);
      const res = await approve(id, { name: other.name.toUpperCase() });
      expect(res.status).toBe(409);
      expect(JSON.stringify(await loadRule(source.id))).toBe(before);
      expect((await loadRules()).length).toBe(count);
      expect((await getLibraryRequest(id))!.status).toBe('open');
      expect((await getPersonalRule((await getLibraryRequest(id))!.personalRuleId!, cast.author))!.libraryRuleId).toBeUndefined();
    });

    it('may keep the target\'s own name, in another case', async () => {
      const source = await libraryRule();
      const id = await sendUpdate(await copyOf(source), source);
      as(cast.admin);
      expect((await approve(id, { name: source.name.toUpperCase() })).status).toBe(201);
      expect((await loadRule(source.id))!.name).toBe(source.name.toUpperCase());
    });

    it('answers 409 when the target was deleted, and creates no rule', async () => {
      const source = await libraryRule();
      const id = await sendUpdate(await copyOf(source), source);
      await deleteRule(source.id);
      const count = (await loadRules()).length;

      as(cast.admin);
      const res = await approve(id);
      expect(res.status).toBe(409);
      expect((await bodyOf<{ error: string }>(res)).error).toContain('no longer exists');
      expect((await loadRules()).length).toBe(count);
      expect((await getLibraryRequest(id))!.status).toBe('open');
    });

    it('answers 409 when the target is not a custom rule, even if a request was forced onto it', async () => {
      const builtin = (await loadRules()).find(r => r.type === 'builtin' && (r.queryBackend ?? 'resource-graph') === 'resource-graph')!;
      const personal = await copyOf(builtin);
      const created = await createLibraryRequest(personal, cast.author);
      if (!created.ok) throw new Error(created.reason);
      await execRaw(`UPDATE library_requests SET target_rule_id = '${builtin.id.replace(/'/g, "''")}' WHERE id = '${created.request.id}'`);
      const before = JSON.stringify(await loadRule(builtin.id));

      as(cast.admin);
      expect((await approve(created.request.id)).status).toBe(409);
      expect(JSON.stringify(await loadRule(builtin.id))).toBe(before);
      expect((await getLibraryRequest(created.request.id))!.status).toBe('open');
    });

    it('refuses to create a request for a built-in target in the repository too', async () => {
      const builtin = (await loadRules()).find(r => r.type === 'builtin' && (r.queryBackend ?? 'resource-graph') === 'resource-graph')!;
      expect(await createLibraryRequest(await copyOf(builtin), cast.author, undefined, builtin.id)).toEqual({ ok: false, reason: 'target-not-custom' });
    });

    it('refuses in the approving transaction when the target is a built-in or gone, even with the route bypassed', async () => {
      const builtin = (await loadRules()).find(r => r.type === 'builtin' && (r.queryBackend ?? 'resource-graph') === 'resource-graph')!;
      const forced = await createLibraryRequest(await copyOf(builtin), cast.author);
      if (!forced.ok) throw new Error(forced.reason);
      await execRaw(`UPDATE library_requests SET target_rule_id = '${builtin.id.replace(/'/g, "''")}' WHERE id = '${forced.request.id}'`);
      const before = JSON.stringify(await loadRule(builtin.id));
      expect(await approveLibraryRequest(forced.request.id, cast.reviewer, {})).toEqual({ ok: false, reason: 'not-custom' });
      expect(JSON.stringify(await loadRule(builtin.id))).toBe(before);

      const source = await libraryRule();
      const id = await sendUpdate(await copyOf(source), source);
      await deleteRule(source.id);
      const count = (await loadRules()).length;
      expect(await approveLibraryRequest(id, cast.reviewer, {})).toEqual({ ok: false, reason: 'target-gone' });
      expect((await loadRules()).length).toBe(count);
      expect((await getLibraryRequest(id))!.status).toBe('open');
    });

    it('keeps the findings, their first-seen ages and the suppressions of the target', async () => {
      const source = await libraryRule();
      const finding = syntheticFinding('vm-update-1', [{ name: 'vm-update-1' }], { ruleId: source.id });
      const suppressed = syntheticFinding('vm-update-2', [{ name: 'vm-update-2' }], { ruleId: source.id });
      await storeScan([finding, suppressed], { scanId: 'scan-before', finishedAt: '2026-01-01T00:00:00.000Z' });
      await addSuppression({
        id: '00000000-0000-0000-0000-0000000000aa', fingerprint: suppressed.fingerprint, resourceId: suppressed.resourceId,
        reason: 'Known', suppressedAt: '2026-01-02T00:00:00.000Z',
      });
      const snapshot = async () => ({
        findings: (await listFindings(EVERYTHING_ACCESS)).filter(f => f.ruleId === source.id).map(f => ({ id: f.fingerprint, firstSeenAt: f.firstSeenAt, status: f.status })).sort((a, b) => a.id.localeCompare(b.id)),
        suppressions: await loadSuppressions(EVERYTHING_ACCESS),
      });
      const before = await snapshot();
      expect(before.findings).toHaveLength(2);
      expect(before.findings.every(f => f.firstSeenAt === '2026-01-01T00:00:00.000Z')).toBe(true);
      expect(before.suppressions).toHaveLength(1);

      const id = await sendUpdate(await copyOf(source, { rawKql: NEW_KQL, severity: 'low' }), source);
      as(cast.admin);
      expect((await approve(id)).status).toBe(201);

      expect(await snapshot()).toEqual(before);
      expect(await loadRule(source.id)).toMatchObject({ severity: 'low', rawKql: NEW_KQL });
    });

    it('audits the approval once as an update, with field names and ids and never the query', async () => {
      const source = await libraryRule();
      const id = await sendUpdate(await copyOf(source, { rawKql: NEW_KQL, severity: 'low' }), source);
      as(cast.admin);
      await approve(id, { name: `${source.name} v2` });

      const approvals = (await listAllAuditEntries()).filter(e => e.action === 'library_request.approve');
      expect(approvals).toHaveLength(1);
      const entry = approvals[0]!;
      expect(entry).toMatchObject({ entityId: id, details: { libraryRuleId: source.id, targetRuleId: source.id, update: true } });
      expect(entry.summary).toContain('as an update to');
      expect((entry.details as { changed: string[] }).changed).toEqual(expect.arrayContaining(['name', 'severity', 'rawKql']));
      expect(JSON.stringify(entry)).not.toContain('westeurope');
      expect(JSON.stringify(entry)).not.toContain('virtualmachines');
    });

    it('refuses a Viewer and an Editor held at a smaller Scope with 403, and changes nothing', async () => {
      const source = await libraryRule();
      const id = await sendUpdate(await copyOf(source, { rawKql: NEW_KQL }), source);
      const before = JSON.stringify(await loadRule(source.id));
      const audits = (await listAllAuditEntries()).length;

      for (const refused of [cast.viewer, cast.scoped]) {
        as(refused);
        expect((await approve(id)).status).toBe(403);
        expect((await view(id)).status).toBe(403);
      }
      expect(JSON.stringify(await loadRule(source.id))).toBe(before);
      expect((await getLibraryRequest(id))!.status).toBe('open');
      expect((await listAllAuditEntries()).length).toBe(audits);
    });
  });
});
