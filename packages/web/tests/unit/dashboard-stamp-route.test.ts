/**
 * #338: the dashboard route computes the effective filters itself. The client sends only how the page's
 * address differs from the saved dashboard, and the stamp names what the person holds of the result.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createPeople, seedMatrix, SUB_ONE, SUB_TWO, type MatrixSeed } from '../helpers/access-matrix';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const { GET } = await import('@/app/api/dashboards/[id]/route');

let people: Record<string, string>;
let seed: MatrixSeed;

beforeAll(async () => {
  await resetDb();
  people = await createPeople();
  seed = await seedMatrix();
});

async function stampFor(person: string, query = '') {
  mockAuth.mockResolvedValue({ user: { uid: people[person] } });
  const res = await GET(new Request(`http://localhost/api/dashboards/x${query}`), { params: Promise.resolve({ id: seed.dashboardId }) });
  expect(res.status).toBe(200);
  return (await res.json() as { stamp: { filters: { dimension: string; values: string[]; heldBack: number }[]; dateWindow: { label: string; from: string; to: string } } }).stamp;
}

describe('GET /api/dashboards/[id] stamp', () => {
  it('uses the saved filters when the address adds none', async () => {
    const stamp = await stampFor('Admin');
    expect(stamp.filters).toEqual([{ dimension: 'subscription', values: [SUB_TWO], heldBack: 0 }]);
    expect(stamp.dateWindow.label).toBe('7d');
  });

  it('lets the address replace a saved dimension and add others, and holds back what the person does not hold', async () => {
    const stamp = await stampFor('Viewer on one subscription', `?subscriptions=${SUB_ONE},${SUB_TWO}&severities=critical&from=2025-12-20&to=2026-01-05`);
    expect(stamp.filters).toEqual([
      { dimension: 'subscription', values: [SUB_ONE], heldBack: 1 },
      { dimension: 'severity', values: ['Critical'], heldBack: 0 },
    ]);
    expect(stamp.dateWindow).toEqual({ label: 'Dec 20, 2025 – Jan 5, 2026', from: '2025-12-20', to: '2026-01-05' });
    expect(JSON.stringify(stamp)).not.toContain(SUB_TWO);
  });

  it('answers 401 with no stamp when nobody is signed in', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(new Request('http://localhost/api/dashboards/x'), { params: Promise.resolve({ id: seed.dashboardId }) });
    expect(res.status).toBe(401);
  });
});
