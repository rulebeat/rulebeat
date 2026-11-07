import type { Dashboard, DashboardConfig, WidgetDef } from './types';
import { snapSpan } from './widget-sizes';

/**
 * What the dashboard client sends to `PUT /api/dashboards/[id]` and how it reads a refusal. Pure, so
 * the contract the route checks (a revision on every save, widths from the size table) is tested
 * without rendering the page.
 */

/** Every width moved to the nearest allowed span (a tie to the smaller), which the PUT accepts. Nothing else changes. */
export function withSnappedWidths(config: DashboardConfig): DashboardConfig {
  return { ...config, widgets: config.widgets.map((w): WidgetDef => ({ ...w, w: snapSpan(w.type, w.w) })) };
}

/**
 * The body of a save: the changed fields, the revision the client read, and the config with its
 * widths snapped. `name` and `config` are left out when not given.
 */
export function saveBody(dashboard: Pick<Dashboard, 'revision'>, change: { name?: string; config?: DashboardConfig }): string {
  return JSON.stringify({
    ...(change.name !== undefined && { name: change.name }),
    ...(change.config !== undefined && { config: withSnappedWidths(change.config) }),
    revision: dashboard.revision,
  });
}

export interface RefusedSave { error?: string; reason?: string; editor?: string | null; at?: string }

/** The sentence a refused save shows: who changed the dashboard and when for a conflict, else the server's own words. */
export function saveFailureMessage(body: RefusedSave, fallback: string): string {
  if (body.reason === 'revision-conflict') {
    const who = body.editor ?? 'Someone who is no longer in RuleBeat';
    const when = body.at && !Number.isNaN(Date.parse(body.at)) ? ` at ${new Date(body.at).toLocaleString()}` : '';
    return `${who} changed this dashboard${when}. Reload the page to see their version before saving again.`;
  }
  return body.error ?? fallback;
}

export type SaveResult =
  | { ok: true; dashboard: Dashboard }
  | { ok: false; refused: RefusedSave };

/**
 * Every save the dashboard page makes goes through one of these. Saves run one at a time, and each
 * is built from the dashboard as it stands when it is sent, so the revision it carries is the one the
 * previous save returned. A filter save waiting out its debounce, a rename and an auto-refresh pick
 * can then overlap without any of them sending a revision the person's own earlier save already
 * moved, which the PUT would refuse as another editor's write.
 */
export function createDashboardSaver(initial: Dashboard, put: (id: string, body: string) => Promise<Response>) {
  let current = initial;
  let tail: Promise<unknown> = Promise.resolve();

  async function send(change: (current: Dashboard) => { name?: string; config?: DashboardConfig }): Promise<SaveResult> {
    const res = await put(current.id, saveBody(current, change(current)));
    if (res.ok) {
      current = await res.json() as Dashboard;
      return { ok: true, dashboard: current };
    }
    return { ok: false, refused: await res.json().catch(() => ({})) as RefusedSave };
  }

  return {
    latest: () => current,
    /** Takes a dashboard returned by some other write (making it the default) as the one to save against. */
    adopt(next: Dashboard) { current = next; },
    save(change: (current: Dashboard) => { name?: string; config?: DashboardConfig }): Promise<SaveResult> {
      const run = tail.then(() => send(change));
      tail = run.catch(() => undefined);
      return run;
    },
  };
}
