/**
 * #311: the person page's form and what Save sends. Pure, so no rendering: what the form opens with, what a Role
 * change does to the access choice, and for every kind of person and choice, which user routes are called with
 * what, in what order, or why Save cannot run yet. The routes themselves are tested in access-page.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { buildAccess, parseScope, type AccessSource, type GrantRole, type ManualGrant } from '@/lib/access-model';
import { initialPersonForm, mixedRoles, planSave, previewUrl, withRole, type PersonForm } from '@/lib/person-form';
import type { Role } from '@/lib/rbac';

const SUB = '/subscriptions/00000000-0000-0000-0000-00000000000a';
const OTHER = '/subscriptions/00000000-0000-0000-0000-00000000000b';
const OBJECT = '00000000-0000-0000-0000-0000000000c1';

function person(role: Role, held: ManualGrant[] = [], accessSource: AccessSource | null = 'manual') {
  const access = buildAccess(held.map(g => ({ tenantId: 't', scope: parseScope(g.scope)!, role: g.role })), accessSource);
  return { id: 'u 1', role, access, accessSource };
}

const form = (change: Partial<PersonForm> = {}): PersonForm =>
  ({ role: 'viewer', choice: null, grants: [], objectId: '', previewedId: null, ...change });

const at = (scope: string, role: GrantRole = 'viewer'): ManualGrant => ({ scope, role });

describe('initialPersonForm', () => {
  it('opens an invite as a Viewer with nothing chosen, so nobody is given access by default', () => {
    expect(initialPersonForm(null)).toEqual(form());
  });

  it('opens an Admin with no access choice', () => {
    expect(initialPersonForm(person('admin', [], null))).toMatchObject({ role: 'admin', choice: null, grants: [] });
  });

  it('opens a person who holds only Everything on Everything, and anyone else on their Selected Scopes', () => {
    expect(initialPersonForm(person('editor', [at('/', 'editor')]))).toMatchObject({ role: 'editor', choice: 'everything' });
    const scoped = initialPersonForm(person('viewer', [at(SUB), at('@directory')]));
    expect(scoped).toMatchObject({ choice: 'scopes', grants: [at(SUB), at('@directory')] });
    expect(initialPersonForm(person('viewer', [at('/'), at(SUB)])).choice).toBe('scopes');
    expect(initialPersonForm(person('viewer', [])).choice).toBe('scopes');
  });

  it('opens a mirrored person on Mirrored, with the Linked account field blank', () => {
    expect(initialPersonForm(person('viewer', [at(SUB)], 'mirrored'))).toMatchObject({ choice: 'mirrored', objectId: '' });
  });
});

describe('withRole', () => {
  it('gives an Admin made a Viewer or Editor Everything until something narrower is chosen', () => {
    const admin = person('admin', [], null);
    expect(withRole(initialPersonForm(admin), 'editor', admin)).toMatchObject({ role: 'editor', choice: 'everything' });
  });

  it('keeps an invite with nothing chosen, and keeps any choice already made', () => {
    expect(withRole(form(), 'editor', null).choice).toBeNull();
    const scoped = person('viewer', [at(SUB)]);
    expect(withRole(initialPersonForm(scoped), 'editor', scoped).choice).toBe('scopes');
  });
});

describe('mixedRoles and previewUrl', () => {
  it('says when Scopes are held at different Roles', () => {
    expect(mixedRoles([at(SUB), at(OTHER, 'editor')])).toBe(true);
    expect(mixedRoles([at(SUB), at(OTHER)])).toBe(false);
    expect(mixedRoles([])).toBe(false);
  });

  it('previews on the person\'s own route, and on the route with no person for an invite or an Admin', () => {
    expect(previewUrl({ id: 'u 1', role: 'viewer' })).toBe('/api/users/u%201/mirror/preview');
    expect(previewUrl({ id: 'u 1', role: 'admin' })).toBe('/api/users/mirror-preview');
    expect(previewUrl(null)).toBe('/api/users/mirror-preview');
  });
});

describe('planSave for an invite', () => {
  const post = (body: Record<string, unknown>) => ({ kind: 'steps', steps: [{ method: 'POST', url: '/api/users', body }] });

  it('needs an email first', () => {
    expect(planSave(null, form({ role: 'admin' }), '  ')).toEqual({ kind: 'blocked', reason: 'Enter a work email.' });
  });

  it('invites an Admin with no access', () => {
    expect(planSave(null, form({ role: 'admin' }), ' a@example.com ')).toEqual(post({ email: 'a@example.com', role: 'admin' }));
  });

  it('needs an access choice for a Viewer or Editor', () => {
    expect(planSave(null, form(), 'a@example.com')).toEqual({ kind: 'blocked', reason: 'Choose what this person can access.' });
  });

  it('sends Everything at the Role', () => {
    expect(planSave(null, form({ role: 'editor', choice: 'everything' }), 'a@example.com'))
      .toEqual(post({ email: 'a@example.com', role: 'editor', source: 'manual', access: [at('/', 'editor')] }));
  });

  it('sends the Selected Scopes, every one at the Role, and needs at least one', () => {
    expect(planSave(null, form({ choice: 'scopes' }), 'a@example.com')).toEqual({ kind: 'blocked', reason: 'Choose at least one Scope.' });
    expect(planSave(null, form({ role: 'editor', choice: 'scopes', grants: [at(SUB), at(OTHER)] }), 'a@example.com'))
      .toEqual(post({ email: 'a@example.com', role: 'editor', source: 'manual', access: [at(SUB, 'editor'), at(OTHER, 'editor')] }));
  });

  it('sends a Linked account only once that exact id was previewed', () => {
    const mirrored = form({ choice: 'mirrored' });
    expect(planSave(null, mirrored, 'a@example.com')).toEqual({ kind: 'blocked', reason: 'Enter the object id of the Linked account.' });
    expect(planSave(null, { ...mirrored, objectId: OBJECT }, 'a@example.com')).toEqual({ kind: 'blocked', reason: 'Preview the Linked account first.' });
    expect(planSave(null, { ...mirrored, objectId: ` ${OBJECT} `, previewedId: OBJECT }, 'a@example.com'))
      .toEqual(post({ email: 'a@example.com', role: 'viewer', source: 'mirrored', objectId: OBJECT }));
  });
});

describe('planSave for an Admin', () => {
  const admin = person('admin', [], null);
  const put = (body: Record<string, unknown>) => ({ kind: 'steps', steps: [{ method: 'PUT', url: '/api/users/u%201', body }] });

  it('changes nothing for an Admin kept an Admin', () => {
    expect(planSave(admin, initialPersonForm(admin))).toEqual({ kind: 'nothing' });
  });

  it('demotes with the access in the same call, as the route requires', () => {
    expect(planSave(admin, form({ role: 'viewer', choice: 'everything' }))).toEqual(put({ role: 'viewer', access: [at('/')] }));
    expect(planSave(admin, form({ role: 'editor', choice: 'scopes', grants: [at(SUB)] })))
      .toEqual(put({ role: 'editor', access: [at(SUB, 'editor')] }));
  });

  it('needs an access choice to demote', () => {
    expect(planSave(admin, form({ role: 'viewer' }))).toEqual({ kind: 'blocked', reason: 'Choose what this person can access.' });
  });

  it('demotes to Mirrored through the two-step demote, after a preview of the id', () => {
    expect(planSave(admin, form({ role: 'editor', choice: 'mirrored', objectId: OBJECT })).kind).toBe('blocked');
    expect(planSave(admin, form({ role: 'editor', choice: 'mirrored', objectId: OBJECT, previewedId: OBJECT })))
      .toEqual({ kind: 'demote-mirrored', role: 'editor', objectId: OBJECT });
  });

  it('promotes a Viewer to Admin with one Role change', () => {
    const viewer = person('viewer', [at(SUB)]);
    expect(planSave(viewer, { ...initialPersonForm(viewer), role: 'admin' })).toEqual(put({ role: 'admin' }));
  });
});

describe('planSave for a Viewer or Editor with Manual access', () => {
  const url = '/api/users/u%201';

  it('changes nothing when nothing changed', () => {
    const viewer = person('viewer', [at(SUB), at(OTHER)]);
    expect(planSave(viewer, initialPersonForm(viewer))).toEqual({ kind: 'nothing' });
  });

  it('sends the new list, every Scope at the Role, and no Role change when the list leaves them at it', () => {
    const viewer = person('viewer', [at(SUB)]);
    const next = { ...initialPersonForm(viewer), grants: [at(SUB), at(OTHER)] };
    expect(planSave(viewer, next)).toEqual({ kind: 'steps', steps: [{ method: 'PUT', url: `${url}/access`, body: { access: [at(SUB), at(OTHER)] } }] });
  });

  it('moves every Scope to the new Role when only the Role changed', () => {
    const viewer = person('viewer', [at(SUB)]);
    const next = withRole(initialPersonForm(viewer), 'editor', viewer);
    expect(planSave(viewer, next)).toEqual({ kind: 'steps', steps: [{ method: 'PUT', url: `${url}/access`, body: { access: [at(SUB, 'editor')] } }] });
  });

  it('gives every Scope one Role when they were held at mixed Roles', () => {
    const mixed = person('editor', [at(SUB), at(OTHER, 'editor')]);
    expect(planSave(mixed, initialPersonForm(mixed))).toEqual({
      kind: 'steps', steps: [{ method: 'PUT', url: `${url}/access`, body: { access: [at(SUB, 'editor'), at(OTHER, 'editor')] } }],
    });
  });

  it('sends the Role as well when the list alone would leave them at another, as for an Editor who holds nothing', () => {
    const viewer = person('viewer', [at(SUB)]);
    const next = { ...withRole(initialPersonForm(viewer), 'editor', viewer), grants: [] };
    expect(planSave(viewer, next)).toEqual({
      kind: 'steps',
      steps: [
        { method: 'PUT', url: `${url}/access`, body: { access: [] } },
        { method: 'PUT', url, body: { role: 'editor' } },
      ],
    });
  });

  it('sends Everything when Everything is chosen', () => {
    const viewer = person('viewer', [at(SUB)]);
    expect(planSave(viewer, { ...initialPersonForm(viewer), choice: 'everything' }))
      .toEqual({ kind: 'steps', steps: [{ method: 'PUT', url: `${url}/access`, body: { access: [at('/')] } }] });
  });

  it('links an account when Mirrored is chosen, after a preview, and needs an id to link', () => {
    const viewer = person('viewer', [at(SUB)]);
    const mirrored = { ...initialPersonForm(viewer), choice: 'mirrored' as const };
    expect(planSave(viewer, mirrored)).toEqual({ kind: 'blocked', reason: 'Enter the object id of the Linked account.' });
    expect(planSave(viewer, { ...mirrored, objectId: OBJECT })).toEqual({ kind: 'blocked', reason: 'Preview the Linked account first.' });
    expect(planSave(viewer, { ...mirrored, objectId: OBJECT, previewedId: OBJECT }))
      .toEqual({ kind: 'steps', steps: [{ method: 'PUT', url: `${url}/mirror`, body: { objectId: OBJECT, role: 'viewer' } }] });
  });
});

describe('planSave for a mirrored Viewer or Editor', () => {
  const url = '/api/users/u%201';
  const mirrored = person('viewer', [at(SUB)], 'mirrored');

  it('changes nothing when nothing changed, and only the Role when only the Role changed', () => {
    expect(planSave(mirrored, initialPersonForm(mirrored))).toEqual({ kind: 'nothing' });
    expect(planSave(mirrored, withRole(initialPersonForm(mirrored), 'editor', mirrored)))
      .toEqual({ kind: 'steps', steps: [{ method: 'PUT', url, body: { role: 'editor' } }] });
  });

  it('relinks a different account once it was previewed', () => {
    const next = { ...initialPersonForm(mirrored), objectId: OBJECT, previewedId: OBJECT };
    expect(planSave(mirrored, next)).toEqual({ kind: 'steps', steps: [{ method: 'PUT', url: `${url}/mirror`, body: { objectId: OBJECT, role: 'viewer' } }] });
  });

  it('turns them manual when Selected Scopes is saved, even with the same Scopes', () => {
    const next = { ...initialPersonForm(mirrored), choice: 'scopes' as const };
    expect(planSave(mirrored, next)).toEqual({ kind: 'steps', steps: [{ method: 'PUT', url: `${url}/access`, body: { access: [at(SUB)] } }] });
  });
});
