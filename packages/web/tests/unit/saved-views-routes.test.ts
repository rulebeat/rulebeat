/**
 * Saved views (#196): the routes, through the real repository, database and audit log. A saved
 * view is shared with everyone on the install, so the contract is who can read it (anyone signed
 * in), who can change it (editor and admin), and that nothing the person typed lands in the audit
 * log.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { listAllAuditEntries } from '@/lib/db/audit';
import { listSavedViews } from '@/lib/db/saved-views';
import { applyView, columnCell, viewFromSearchParams } from '@/lib/finding-view';
import type { SavedView } from '@/lib/saved-view-query';
import type { Role } from '@/lib/rbac';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const { GET: LIST, POST } = await import('@/app/api/views/route');
const { GET: READ, PATCH, DELETE } = await import('@/app/api/views/[id]/route');

async function signInAs(role: Role): Promise<void> {
  const result = await createUser({ email: `${role}-${Math.random().toString(36).slice(2)}@example.com`, role });
  if ('error' in result) throw new Error(result.error);
  await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
}

function json(method: string, payload: unknown): Request {
  return new Request('http://localhost/api/views', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

const post = (payload: unknown) => POST(json('POST', payload));
const patch = (id: string, payload: unknown) => PATCH(json('PATCH', payload), { params: Promise.resolve({ id }) });
const read = (id: string) => READ(new Request('http://localhost/api/views/x'), { params: Promise.resolve({ id }) });
const remove = (id: string) => DELETE(new Request('http://localhost/api/views/x', { method: 'DELETE' }), { params: Promise.resolve({ id }) });

async function created(name: string, overrides: Record<string, unknown> = {}): Promise<SavedView> {
  const res = await post({ name, tab: 'results', query: 'severity=critical', ...overrides });
  expect(res.status).toBe(201);
  return await res.json() as SavedView;
}

const viewAudit = async () => (await listAllAuditEntries()).filter(e => e.entityType === 'saved_view');

describe('saved views routes', () => {
  beforeEach(async () => {
    await resetDb();
    mockAuth.mockReset();
    await signInAs('editor');
  });

  describe('who can do what', () => {
    it('lets a viewer list and open a view but refuses every write', async () => {
      const view = await created('Critical only');
      await signInAs('viewer');

      const list = await LIST();
      expect(list.status).toBe(200);
      expect((await list.json() as SavedView[]).map(v => v.name)).toEqual(['Critical only']);
      expect((await read(view.id)).status).toBe(200);

      expect((await post({ name: 'Mine', tab: 'results', query: '' })).status).toBe(403);
      expect((await patch(view.id, { name: 'Renamed' })).status).toBe(403);
      expect((await remove(view.id)).status).toBe(403);
      expect((await listSavedViews()).map(v => v.name)).toEqual(['Critical only']);
    });

    it('lets an editor and an admin write', async () => {
      const view = await created('From the editor');
      await signInAs('admin');

      expect((await patch(view.id, { name: 'From the admin' })).status).toBe(200);
      expect((await post({ name: 'Second', tab: 'advisories', query: '' })).status).toBe(201);
      expect((await remove(view.id)).status).toBe(204);
    });

    it('refuses a request with no session', async () => {
      mockAuth.mockResolvedValue(null);
      expect((await LIST()).status).toBe(401);
      expect((await post({ name: 'x', tab: 'results', query: '' })).status).toBe(401);
    });

    it('shares a view with everyone: another person sees what an editor saved', async () => {
      await created('Shared one');
      await signInAs('editor');
      const names = (await (await LIST()).json() as SavedView[]).map(v => v.name);
      expect(names).toEqual(['Shared one']);
    });
  });

  describe('validation', () => {
    it('rejects a missing, blank or oversized name', async () => {
      expect((await post({ tab: 'results', query: '' })).status).toBe(400);
      expect((await post({ name: '   ', tab: 'results', query: '' })).status).toBe(400);
      expect((await post({ name: 'x'.repeat(101), tab: 'results', query: '' })).status).toBe(400);
    });

    it('rejects an unknown tab and a non-string query', async () => {
      expect((await post({ name: 'A', tab: 'runs', query: '' })).status).toBe(400);
      expect((await post({ name: 'A', query: '' })).status).toBe(400);
      expect((await post({ name: 'A', tab: 'results', query: 5 })).status).toBe(400);
      expect((await post({ name: 'A', tab: 'results' })).status).toBe(400);
    });

    it('rejects a query over the length limit', async () => {
      const res = await post({ name: 'Long', tab: 'results', query: `q=${'a'.repeat(4001)}` });
      expect(res.status).toBe(400);
      expect(await listSavedViews()).toHaveLength(0);
    });

    it('measures the query as sent, so a long one that would normalise to nothing is still refused', async () => {
      const res = await post({ name: 'Padded', tab: 'results', query: `junk=${'a'.repeat(4001)}` });
      expect(res.status).toBe(400);
      expect(await listSavedViews()).toHaveLength(0);
    });

    it('rejects an update that sends nothing to change', async () => {
      const view = await created('Keep');
      expect((await patch(view.id, {})).status).toBe(400);
    });

    it('trims the name', async () => {
      expect((await created('  Padded  ')).name).toBe('Padded');
    });

    it('answers 404 for an unknown id on read, update and delete', async () => {
      expect((await read('nope')).status).toBe(404);
      expect((await patch('nope', { name: 'x' })).status).toBe(404);
      expect((await remove('nope')).status).toBe(404);
    });
  });

  describe('names', () => {
    it('answers 409 for a name already taken, whatever its case', async () => {
      await created('Critical');
      const res = await post({ name: 'CRITICAL ', tab: 'results', query: '' });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe('A saved view named "CRITICAL" already exists.');
      expect(await listSavedViews()).toHaveLength(1);
    });

    it('answers 409 when a rename takes another view\'s name, and allows keeping or recasing its own', async () => {
      const a = await created('Alpha');
      await created('Beta');

      expect((await patch(a.id, { name: 'beta' })).status).toBe(409);
      expect((await patch(a.id, { name: 'ALPHA' })).status).toBe(200);
      expect((await listSavedViews()).map(v => v.name).sort()).toEqual(['ALPHA', 'Beta']);
    });

    it('lets exactly one of two concurrent creates with the same name through', async () => {
      const [a, b] = await Promise.all([
        post({ name: 'Race', tab: 'results', query: '' }),
        post({ name: 'RACE', tab: 'results', query: '' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect(await listSavedViews()).toHaveLength(1);
    });

    it('lists views by name regardless of case', async () => {
      await created('banana');
      await created('Cherry');
      await created('Apple');
      expect((await listSavedViews()).map(v => v.name)).toEqual(['Apple', 'banana', 'Cherry']);
    });
  });

  describe('what is stored', () => {
    it('stores the tab, the actor and the normalised query', async () => {
      const view = await created('Normalised', { tab: 'advisories', query: 'tab=advisories&view=abc&status=open&severity=critical&bogus=1' });
      expect(view.tab).toBe('advisories');
      expect(view.query).toBe('severity=critical');
      expect(view.createdBy).toBeTruthy();
      expect(view.updatedBy).toBe(view.createdBy);
    });

    it('stores an empty query for a default view', async () => {
      expect((await created('Default', { query: '' })).query).toBe('');
    });

    it('updates the query and tab and records who and when', async () => {
      const view = await created('Moves');
      await signInAs('admin');
      const res = await patch(view.id, { tab: 'advisories', query: 'severity=high' });
      const updated = await res.json() as SavedView;
      expect(updated).toMatchObject({ id: view.id, name: 'Moves', tab: 'advisories', query: 'severity=high' });
      expect(updated.updatedBy).not.toBe(view.createdBy);
      expect(updated.createdBy).toBe(view.createdBy);
    });

    it('round-trips a view that names a column some findings lack, and still returns them with an empty cell', async () => {
      const query = 'cols=properties.tier&sort=row.properties.tier%3Aasc';
      const view = await created('Missing column', { query });
      const stored = (await (await read(view.id)).json() as SavedView).query;
      expect(stored).toContain('properties.tier');

      const now = new Date().toISOString();
      const finding = (id: string, rows: Record<string, unknown>[]) => ({
        fingerprint: id, category: 'reliability' as const, severity: 'medium' as const, status: 'active' as const,
        ruleId: 'rule-a', subscriptionId: 'sub-1', resourceGroup: 'rg-1', location: 'westeurope',
        resourceType: 'microsoft.storage/storageaccounts', resourceName: id, resourceId: `/subscriptions/sub-1/${id}`,
        title: 'title', firstSeenAt: now, lastSeenAt: now, policyName: 'Rule A', ruleTags: [], rows,
      });
      const has = finding('has-column', [{ properties: { tier: 'premium' } }]);
      const lacks = finding('lacks-column', [{ properties: { sku: 'basic' } }]);

      const page = applyView([lacks, has], viewFromSearchParams(new URLSearchParams(stored)));
      expect(page.items.map(i => i.finding.fingerprint)).toEqual(['has-column', 'lacks-column']);
      const cells = Object.fromEntries(page.items.map(i => [i.finding.fingerprint, columnCell(i.rows, 'properties.tier')]));
      expect(cells['has-column'].value).toEqual({ kind: 'text', text: 'premium' });
      expect(cells['lacks-column']).toEqual({ value: { kind: 'empty' }, more: 0 });
    });

    it('deletes the view', async () => {
      const view = await created('Gone soon');
      expect((await remove(view.id)).status).toBe(204);
      expect((await read(view.id)).status).toBe(404);
      expect(await listSavedViews()).toHaveLength(0);
    });
  });

  describe('audit', () => {
    it('writes one row per change with field names and no values', async () => {
      const view = await created('Secret Name', { query: 'q=hunter2' });
      await patch(view.id, { name: 'Other Secret' });
      await patch(view.id, { query: 'q=correct-horse', tab: 'advisories' });
      await remove(view.id);

      // Rows written in the same millisecond have no defined order, so look each up by action.
      const entries = await viewAudit();
      const byAction = (action: string) => entries.filter(e => e.action === action);
      expect(entries.map(e => e.action).sort()).toEqual(['view.create', 'view.delete', 'view.rename', 'view.update']);
      expect(entries.every(e => e.entityId === view.id)).toBe(true);
      expect(byAction('view.create')[0].details).toEqual({ fields: ['name', 'tab', 'query'] });
      expect(byAction('view.rename')[0].details).toEqual({ fields: ['name'] });
      expect(byAction('view.update')[0].details).toEqual({ fields: ['tab', 'query'] });

      const detailsText = JSON.stringify(entries.map(e => e.details));
      for (const value of ['Secret Name', 'Other Secret', 'hunter2', 'correct-horse']) {
        expect(detailsText).not.toContain(value);
      }
    });

    it('writes nothing for a refused write or a clashing name', async () => {
      const view = await created('One');
      const before = (await viewAudit()).length;
      await post({ name: 'one', tab: 'results', query: '' });
      await patch('nope', { name: 'x' });
      await signInAs('viewer');
      await patch(view.id, { name: 'Nope' });
      expect(await viewAudit()).toHaveLength(before);
    });

    it('writes nothing when an update changes nothing', async () => {
      const view = await created('Same');
      const before = (await viewAudit()).length;
      expect((await patch(view.id, { name: 'Same', query: 'severity=critical' })).status).toBe(200);
      expect(await viewAudit()).toHaveLength(before);
    });
  });
});
