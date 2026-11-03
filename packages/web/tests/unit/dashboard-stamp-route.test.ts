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
    const stamp = await stampFor('Viewer on one subscription', `?subscription=${SUB_ONE},${SUB_TWO}&severity=critical&from=2025-12-20&to=2026-01-05`);
    expect(stamp.filters).toEqual([
      { dimension: 'subscription', values: [SUB_ONE], heldBack: 1 },
      { dimension: 'severity', values: ['Critical'], heldBack: 0 },
    ]);
    expect(stamp.dateWindow).toEqual({ label: 'Dec 20, 2025 – Jan 5, 2026', from: '2025-12-20', to: '2026-01-05' });
    expect(JSON.stringify(stamp)).not.toContain(SUB_TWO);
  });

  it('keeps the label and the dates of a window it cannot read or has to clamp in agreement', async () => {
    const bad = await stampFor('Admin', '?from=2026-13-40&to=2026-01-01');
    expect(bad.dateWindow.label).toBe('7d');
    const backwards = await stampFor('Admin', '?from=2026-02-01&to=2026-01-01');
    expect(backwards.dateWindow).toEqual({ label: 'Jan 1, 2026 – Jan 1, 2026', from: '2026-01-01', to: '2026-01-01' });
  });

  it('never names a held-back subscription anywhere in the response', async () => {
    mockAuth.mockResolvedValue({ user: { uid: people['Viewer on one subscription'] } });
    const res = await GET(new Request('http://localhost/api/dashboards/x'), { params: Promise.resolve({ id: seed.dashboardId }) });
    expect(JSON.stringify(await res.json())).not.toContain(SUB_TWO);
  });

  it('answers 401 with no stamp when nobody is signed in', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(new Request('http://localhost/api/dashboards/x'), { params: Promise.resolve({ id: seed.dashboardId }) });
    expect(res.status).toBe(401);
  });
});
