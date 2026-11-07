/**
 * #274: a saved view filtered to a subscription the person holds no Scope in still opens. The view comes
 * back as stored with the subscription marked, the findings read answers 200 with nothing and the same
 * marks, and the explorer's empty state follows from them as access, not as "no findings match".
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createPeople, seedMatrix, SUB_ONE, SUB_TWO, type MatrixSeed } from '../helpers/access-matrix';
import { viewFromSearchParams } from '@/lib/finding-view';
import { emptyListCopy, emptyReasonOf, filterChipLabel } from '@/lib/explorer-screen';
import { OUTSIDE_ACCESS_LABEL } from '@/lib/outside-access';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const { GET: READ } = await import('@/app/api/views/[id]/route');
const { GET: VIEW } = await import('@/app/api/findings/view/route');

let people: Record<string, string>;
let seed: MatrixSeed;

beforeAll(async () => {
  await resetDb();
  people = await createPeople();
  seed = await seedMatrix();
});

const signIn = (person: string) => mockAuth.mockResolvedValue({ user: { uid: people[person] } });

async function open(person: string): Promise<{ query: string; outsideAccess: { subscriptions: string[]; resourceGroups: string[] } }> {
  signIn(person);
  const res = await READ(new Request('http://localhost/api/views/x'), { params: Promise.resolve({ id: seed.savedViewId }) });
  expect(res.status).toBe(200);
  return await res.json() as never;
}

async function read(person: string, query: string) {
  signIn(person);
  const res = await VIEW(new Request(`http://localhost/api/findings/view?${query}`));
  expect(res.status).toBe(200);
  return await res.json() as { total: number; items: unknown[]; outsideAccess: { subscriptions: string[]; resourceGroups: string[] } };
}

describe('a saved view filtered to subscription two, opened by the Viewer on subscription one', () => {
  it('opens with the stored query unchanged and the subscription marked', async () => {
    const view = await open('Viewer on one subscription');
    expect(view.query).toBe(`subscription=${SUB_TWO}`);
    expect(view.outsideAccess).toEqual({ subscriptions: [SUB_TWO], resourceGroups: [] });
  });

  it('reads as an empty result carrying the same marks, with no 403 or 400', async () => {
    const view = await open('Viewer on one subscription');
    const result = await read('Viewer on one subscription', view.query);
    expect(result.total).toBe(0);
    expect(result.items).toEqual([]);
    expect(result.outsideAccess).toEqual({ subscriptions: [SUB_TWO], resourceGroups: [] });
  });

  it('shows "Outside your access" on the chip and an empty state that names access', async () => {
    const view = await open('Viewer on one subscription');
    const result = await read('Viewer on one subscription', view.query);
    const { filters } = viewFromSearchParams(new URLSearchParams(view.query));
    const reason = emptyReasonOf({ filters, outsideAccess: result.outsideAccess });
    expect(reason).toBe('access');
    expect(emptyListCopy(reason, 'findings')).not.toContain('No findings match your filters');
    const chip = filterChipLabel('subscription', SUB_TWO, result.outsideAccess, value => `named ${value}`);
    expect(chip).toBe(OUTSIDE_ACCESS_LABEL);
    expect(chip).not.toContain(SUB_TWO);
  });

  it('is unmarked for the Admin, who sees the subscription\'s own finding', async () => {
    const view = await open('Admin');
    expect(view.outsideAccess).toEqual({ subscriptions: [], resourceGroups: [] });
    const result = await read('Admin', view.query);
    expect(result.total).toBe(1);
    expect(result.outsideAccess).toEqual({ subscriptions: [], resourceGroups: [] });
  });

  it('keeps the ordinary empty copy for a scoped person whose own estate is clean', async () => {
    const query = `subscription=${SUB_ONE}&severity=low`;
    const result = await read('Viewer on one subscription', query);
    expect(result.total).toBe(0);
    expect(result.outsideAccess).toEqual({ subscriptions: [], resourceGroups: [] });
    const { filters } = viewFromSearchParams(new URLSearchParams(query));
    const reason = emptyReasonOf({ filters, outsideAccess: result.outsideAccess });
    expect(emptyListCopy(reason, 'findings')).toBe('No findings match your filters');
  });
});
