/**
 * The refusals of "Update with current view" as the route answers them. Writing a view is install-wide, so
 * no real person with less than Everything reaches the route today; the actor here is one who would, to show
 * that the route stores nothing a person cannot see and says what to do instead (ADR 0013).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSavedView, getSavedView } from '@/lib/db/saved-views';
import { listAllAuditEntries } from '@/lib/db/audit';
import { createUser } from '@/lib/db/users';
import { buildAccess } from '@/lib/access-model';
import { resetDb } from '../helpers/db';

const SUB_A = '00000000-0000-0000-0000-00000000000a';
const SUB_B = '00000000-0000-0000-0000-00000000000b';
const SUB_D = '00000000-0000-0000-0000-00000000000d';
const holdingB = buildAccess([{ tenantId: 't', scope: { kind: 'subscription', path: `/subscriptions/${SUB_B}` }, role: 'editor' }], 'manual');

const signedIn = vi.hoisted(() => ({ actor: null as unknown }));
vi.mock('@/lib/api-auth', () => ({ requireRole: async () => signedIn.actor }));

const { PATCH } = await import('@/app/api/views/[id]/route');

let id: string;
let revision: number;
beforeEach(async () => {
  await resetDb();
  const person = await createUser({ email: 'scoped@example.com', role: 'editor' });
  if ('error' in person) throw new Error(person.error);
  signedIn.actor = { ...person.user, access: holdingB };
  const made = await createSavedView({ name: `scoped ${crypto.randomUUID()}`, tab: 'results', query: `subscription=${SUB_A}%2C${SUB_B}` }, null);
  if (!made.ok) throw new Error('create failed');
  id = made.view.id;
  revision = made.view.revision;
});

const patch = (changes: string) => PATCH(
  new Request('http://localhost/api/views/x', { method: 'PATCH', body: JSON.stringify({ revision, changes }), headers: { 'Content-Type': 'application/json' } }),
  { params: Promise.resolve({ id }) },
);

describe('PATCH /api/views/[id] for someone who does not hold every saved value', () => {
  it('refuses a value outside their Access with 422, says how many, and writes nothing', async () => {
    const res = await patch(`subscription=${SUB_B},${SUB_D}`);
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string; code: string; count: number };
    expect(body).toMatchObject({ code: 'outside-access', count: 1 });
    expect(body.error).toContain('1 value outside your access');
    expect(body.error).not.toContain(SUB_D);
    expect((await getSavedView(id))!.revision).toBe(revision);
    expect(await listAllAuditEntries()).toHaveLength(0);
  });

  it('refuses Any over saved values they do not hold with 422', async () => {
    const res = await patch('subscription=');
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'any-over-held-back', dimensions: ['subscription'] });
    expect((await getSavedView(id))!.revision).toBe(revision);
  });

  it('saves a change to another dimension and keeps the held-back values', async () => {
    const res = await patch('severity=low');
    expect(res.status).toBe(200);
    expect(new URLSearchParams((await getSavedView(id))!.query).get('subscription')).toBe(`${SUB_A},${SUB_B}`);
    expect((await listAllAuditEntries()).map(e => e.action)).toEqual(['view.update']);
  });
});
