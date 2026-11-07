/**
 * Issue #419: the dashboard client sends the revision with every save it makes, and widths the PUT
 * accepts. Checked through the helpers the client builds its requests with, and against the real
 * validation the route applies to them.
 */
import { describe, expect, it } from 'vitest';
import { createDashboardSaver, saveBody, saveFailureMessage, withSnappedWidths } from '@/lib/dashboard-save';
import { dashboardConfigProblem } from '@/lib/dashboard-config-validation';
import type { Dashboard, DashboardConfig } from '@/lib/types';

const config = (w: number, type = 'stat-card'): DashboardConfig =>
  ({ autoRefresh: 30, widgets: [{ id: 'w1', type: type as never, title: 'T', x: 0, y: 0, w, h: 3, config: { metric: 'm' } }] });

describe('saveBody', () => {
  it('carries the revision the client read, with a name, a config, or both', () => {
    expect(JSON.parse(saveBody({ revision: 7 }, { name: 'New' }))).toEqual({ name: 'New', revision: 7 });
    expect(JSON.parse(saveBody({ revision: 7 }, { config: config(3) }))).toEqual({ config: config(3), revision: 7 });
    expect(JSON.parse(saveBody({ revision: 2 }, { name: 'N', config: config(3) }))).toMatchObject({ name: 'N', revision: 2 });
  });

  it('sends widths the PUT accepts, whatever the grid left them at', () => {
    for (let w = 1; w <= 12; w++) {
      const sent = JSON.parse(saveBody({ revision: 1 }, { config: config(w) })) as { config: DashboardConfig };
      expect(dashboardConfigProblem(sent.config, { widgets: [] }), `w=${w}`).toBeNull();
    }
  });
});

describe('withSnappedWidths', () => {
  it('moves only w, to the nearest allowed span, and leaves the rest as it was', () => {
    const before = config(5);
    const after = withSnappedWidths(before);
    expect(after.widgets[0]).toEqual({ ...before.widgets[0], w: 4 });
    expect(after.autoRefresh).toBe(30);
    expect(before.widgets[0]!.w).toBe(5);
  });

  it('leaves a width already allowed, and an empty layout, alone', () => {
    expect(withSnappedWidths(config(6))).toEqual(config(6));
    expect(withSnappedWidths({ widgets: [] })).toEqual({ widgets: [] });
  });
});

describe('saveFailureMessage', () => {
  it('names who changed the dashboard and when, for a conflict', () => {
    const message = saveFailureMessage({ reason: 'revision-conflict', editor: 'Olga Other', at: '2026-06-01T10:00:00.000Z', error: 'server words' }, 'fallback');
    expect(message).toContain('Olga Other changed this dashboard at ');
    expect(message).not.toContain('server words');
  });

  it('says so when the editor is no longer in RuleBeat', () => {
    expect(saveFailureMessage({ reason: 'revision-conflict', editor: null, at: '2026-06-01T10:00:00.000Z' }, 'fallback')).toContain('Someone who is no longer in RuleBeat changed');
  });

  it('omits a time it cannot read', () => {
    expect(saveFailureMessage({ reason: 'revision-conflict', editor: 'Olga', at: 'garbled' }, 'f')).toMatch(/^Olga changed this dashboard\. /);
  });

  it('uses the server\'s words for any other refusal, else the fallback', () => {
    expect(saveFailureMessage({ reason: 'name-taken', error: 'A dashboard named "X" already exists.' }, 'fallback')).toBe('A dashboard named "X" already exists.');
    expect(saveFailureMessage({}, 'Failed to save.')).toBe('Failed to save.');
  });
});

describe('createDashboardSaver', () => {
  const stored = (revision: number, over: Partial<Dashboard> = {}): Dashboard =>
    ({ id: 'd1', name: 'Mine', revision, config: config(3), ...over }) as Dashboard;

  /** A server that accepts a save only at the revision it holds, as the PUT does, and answers 200 with the next one. */
  function fakeServer(start: number) {
    let revision = start;
    const bodies: { revision: number; name?: string; config?: DashboardConfig }[] = [];
    const put = async (_id: string, body: string): Promise<Response> => {
      const sent = JSON.parse(body) as { revision: number; name?: string; config?: DashboardConfig };
      bodies.push(sent);
      await Promise.resolve();
      if (sent.revision !== revision) return new Response(JSON.stringify({ reason: 'revision-conflict', editor: 'Me', at: '2026-06-01T10:00:00.000Z' }), { status: 409 });
      revision += 1;
      return new Response(JSON.stringify(stored(revision, { name: sent.name ?? 'Mine', config: sent.config ?? config(3) })), { status: 200 });
    };
    return { put, bodies };
  }

  it('sends the revision the previous save returned, even when two saves are started back to back', async () => {
    const server = fakeServer(5);
    const saver = createDashboardSaver(stored(5), server.put);
    const [a, b] = await Promise.all([
      saver.save(() => ({ name: 'One' })),
      saver.save(() => ({ name: 'Two' })),
    ]);
    expect([a.ok, b.ok]).toEqual([true, true]);
    expect(server.bodies.map(s => s.revision)).toEqual([5, 6]);
    expect(saver.latest().revision).toBe(7);
  });

  it('builds a change from the dashboard as it is when the save is sent, not when it was asked for', async () => {
    const server = fakeServer(1);
    const saver = createDashboardSaver(stored(1), server.put);
    const first = saver.save(() => ({ config: { ...config(3), autoRefresh: 60 } }));
    const second = saver.save(current => ({ config: { ...current.config, filters: { categories: ['cost'] } as never } }));
    await Promise.all([first, second]);
    expect(server.bodies[1]!.config).toMatchObject({ autoRefresh: 60, filters: { categories: ['cost'] } });
  });

  it('adopts a dashboard another write returned, so the next save carries its revision', async () => {
    const server = fakeServer(4);
    const saver = createDashboardSaver(stored(3), server.put);
    saver.adopt(stored(4));
    expect((await saver.save(() => ({ name: 'X' }))).ok).toBe(true);
    expect(server.bodies[0]!.revision).toBe(4);
  });

  it('reports a refusal with the server\'s body and keeps the dashboard it had', async () => {
    const saver = createDashboardSaver(stored(2), fakeServer(9).put);
    const result = await saver.save(() => ({ name: 'X' }));
    expect(result).toMatchObject({ ok: false, refused: { reason: 'revision-conflict', editor: 'Me' } });
    expect(saver.latest().revision).toBe(2);
  });

  it('keeps saving after a refused save', async () => {
    const server = fakeServer(2);
    const saver = createDashboardSaver(stored(1), server.put);
    expect((await saver.save(() => ({ name: 'X' }))).ok).toBe(false);
    saver.adopt(stored(2));
    expect((await saver.save(() => ({ name: 'Y' }))).ok).toBe(true);
  });
});
