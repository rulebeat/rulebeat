/**
 * Issue #419: the dashboard client sends the revision with every save it makes, and widths the PUT
 * accepts. Checked through the helpers the client builds its requests with, and against the real
 * validation the route applies to them.
 */
import { describe, expect, it } from 'vitest';
import { saveBody, saveFailureMessage, withSnappedWidths } from '@/lib/dashboard-save';
import { dashboardConfigProblem } from '@/lib/dashboard-config-validation';
import type { DashboardConfig } from '@/lib/types';

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
