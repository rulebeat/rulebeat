/**
 * The cases of the upgrade that turns dashboard filters and saved view queries into Scope picks, written once
 * and run on SQLite (db-migrations-filter-conversion.test.ts) and on Postgres (pg-bootstrap-filter-conversion
 * .test.ts). Each backend hands over a harness that can run SQL on its database and run its own start-up step.
 * The assertions read the content back: what was converted, and everything beside it that must not move.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildAccess, parseScope, type Access } from '@/lib/access-model';
import { scopeChips } from '@/lib/filter-states';
import { scopePickStates } from '@/lib/scope-picks';
import { MAX_SAVED_VIEW_QUERY_LENGTH } from '@/lib/saved-view-query';

export interface ConversionHarness {
  /** Empties what the cases write: findings, scan records, saved views, scope sets and their own dashboards. */
  reset(): Promise<void>;
  run(statement: string): Promise<void>;
  all(statement: string): Promise<Record<string, unknown>[]>;
  /** The backend's own start-up step: runMigrations() on SQLite, bootstrapPg() on Postgres. */
  startUp(): Promise<void>;
}

const SUB_A = '00000000-0000-0000-0000-00000000000a';
const SUB_B = '00000000-0000-0000-0000-00000000000b';
const SUB_C = '00000000-0000-0000-0000-00000000000c';
const sub = (n: number) => `10000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const rgPath = (s: string, g: string) => `/subscriptions/${s}/resourceGroups/${g}`;

const lit = (v: string | null) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`);

interface DashboardConfigJson {
  widgets: unknown[];
  autoRefresh?: number;
  filters?: Record<string, string[]>;
  windowDays?: number;
  dateWindow?: unknown;
  dimensionFilters?: Record<string, unknown>;
  convertedFrom?: Record<string, unknown>;
}

const WIDGETS = [{ id: 'w1', type: 'stat-card', x: 0, y: 0, w: 3, h: 2, config: { subscriptions: [SUB_A], metric: 'total-findings' } }];

export function defineFilterConversionCases(harness: () => ConversionHarness): void {
  const h = () => harness();
  let nextFingerprint = 0;

  async function finding(subscription: string, group: string, status = 'active'): Promise<void> {
    const fp = `conv-fp-${nextFingerprint++}`;
    await h().run(`
      INSERT INTO findings (fingerprint, rule_id, category, severity, subscription_id, resource_group, title, status, first_seen_at, last_seen_at)
      VALUES ('${fp}', 'conv-rule', 'compliance', 'high', ${lit(subscription)}, ${lit(group)}, 'A finding', '${status}', '2026-01-02T03:04:05.000Z', '2026-02-03T04:05:06.000Z')`);
  }

  async function record(subscription: string, group: string): Promise<void> {
    const fp = `conv-rec-${nextFingerprint++}`;
    await h().run(`
      INSERT INTO scan_findings (scan_id, fingerprint, rule_id, severity, title, kind, category, resource_group, subscription_id, row_count)
      VALUES ('conv-scan', '${fp}', 'conv-rule', 'high', 'A finding', 'state', 'compliance', ${lit(group)}, ${lit(subscription)}, 1)`);
  }

  async function dashboard(id: string, config: DashboardConfigJson): Promise<void> {
    await h().run(`INSERT INTO dashboards (id, name, config, is_default, created_at)
      VALUES ('${id}', '${id}', ${lit(JSON.stringify(config))}, false, '2026-01-01T00:00:00.000Z')`);
  }

  async function savedView(id: string, query: string): Promise<void> {
    await h().run(`INSERT INTO saved_views (id, name, tab, query, created_at, updated_at)
      VALUES ('${id}', '${id}', 'results', ${lit(query)}, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
  }

  async function config(id: string): Promise<DashboardConfigJson> {
    const rows = await h().all(`SELECT config FROM dashboards WHERE id = '${id}'`);
    return JSON.parse(rows[0]!.config as string) as DashboardConfigJson;
  }

  async function query(id: string): Promise<string> {
    return (await h().all(`SELECT query FROM saved_views WHERE id = '${id}'`))[0]!.query as string;
  }

  async function scopeSetPaths(hash: string): Promise<string[]> {
    return JSON.parse((await h().all(`SELECT paths FROM scope_sets WHERE hash = '${hash}'`))[0]!.paths as string) as string[];
  }

  const everything = async () => {
    await h().reset();
    await h().run(`DELETE FROM dashboards WHERE id LIKE 'conv-%'`);
  };

  /** The pairs on record: a finding at each status, a finding whose group differs only by case, and a pair only a scan record holds. */
  async function recordPairs(): Promise<void> {
    await finding(SUB_A, 'rg-app');
    await finding(SUB_B, 'RG-App', 'fixed');
    await finding(SUB_A, 'rg-data');
    await record(SUB_B, 'rg-old');
    await record(SUB_C, 'rg-app');
  }

  describe('dashboard filters', () => {
    it('keeps a subscription as /subscriptions/{id}, the Directory as @directory, and converts every other dimension', async () => {
      await everything();
      await dashboard('conv-plain', {
        widgets: WIDGETS, autoRefresh: 60,
        filters: {
          categories: ['compliance'], subscriptions: [SUB_A, 'directory'], tags: ['framework:iso27001'],
          severities: ['high', 'critical'], ruleIds: ['rule-1'],
        },
        dateWindow: { mode: 'custom', from: '2026-01-01', to: '2026-01-31' },
      });

      await h().startUp();

      const stored = await config('conv-plain');
      expect(stored.dimensionFilters).toEqual({
        category: ['compliance'], scope: [`/subscriptions/${SUB_A}`, '@directory'], tags: ['framework:iso27001'],
        severity: ['high', 'critical'], rule: ['rule-1'], window: { mode: 'custom', from: '2026-01-01', to: '2026-01-31' },
      });
    });

    it('leaves the legacy values, the widgets and the layout exactly as they were, and records what it converted from', async () => {
      await everything();
      const legacy = {
        categories: ['compliance'], subscriptions: [SUB_A], resourceGroups: ['rg-x'], tags: ['t'], severities: ['low'], ruleIds: ['r'],
      };
      await dashboard('conv-legacy', { widgets: WIDGETS, autoRefresh: 30, filters: legacy, windowDays: 7 });

      await h().startUp();

      const stored = await config('conv-legacy');
      expect(stored.filters).toEqual(legacy);
      expect(stored.windowDays).toBe(7);
      expect(stored.widgets).toEqual(WIDGETS);
      expect(stored.autoRefresh).toBe(30);
      expect(stored.convertedFrom).toEqual({ filters: legacy, windowDays: 7 });
    });

    it('converts the legacy windowDays when there is no dateWindow, and prefers dateWindow when there is one', async () => {
      await everything();
      await dashboard('conv-days', { widgets: [], windowDays: 30 });
      await dashboard('conv-both', { widgets: [], windowDays: 30, dateWindow: { mode: 'relative', days: 1 } });

      await h().startUp();

      expect((await config('conv-days')).dimensionFilters).toEqual({ window: { mode: 'relative', days: 30 } });
      expect((await config('conv-both')).dimensionFilters).toEqual({ window: { mode: 'relative', days: 1 } });
    });

    it('turns empty lists into Inherit, and leaves a dashboard with nothing to convert byte for byte as it was', async () => {
      await everything();
      const empty = { widgets: WIDGETS, filters: { categories: [], subscriptions: [], resourceGroups: [], tags: [], severities: [], ruleIds: [] } };
      await dashboard('conv-empty', empty);
      await dashboard('conv-mixed', { widgets: [], filters: { categories: [], tags: ['t'] } });
      const before = (await h().all(`SELECT config FROM dashboards WHERE id = 'conv-empty'`))[0]!.config;

      await h().startUp();

      expect((await h().all(`SELECT config FROM dashboards WHERE id = 'conv-empty'`))[0]!.config).toBe(before);
      expect((await config('conv-mixed')).dimensionFilters).toEqual({ tags: ['t'] });
    });

    it('converts subscriptions with resource group names to the full cross product', async () => {
      await everything();
      await recordPairs();
      await dashboard('conv-cross', { widgets: [], filters: { subscriptions: [SUB_A, SUB_B], resourceGroups: ['rg-x', 'rg-y'] } });

      await h().startUp();

      expect((await config('conv-cross')).dimensionFilters).toEqual({
        scope: [rgPath(SUB_A, 'rg-x'), rgPath(SUB_A, 'rg-y'), rgPath(SUB_B, 'rg-x'), rgPath(SUB_B, 'rg-y')],
      });
    });

    it('converts a name-only resource group to every pair on record with that name, whatever its case, record or status', async () => {
      await everything();
      await recordPairs();
      await dashboard('conv-name', { widgets: [], filters: { resourceGroups: ['RG-APP'] } });

      await h().startUp();

      expect((await config('conv-name')).dimensionFilters).toEqual({
        scope: [rgPath(SUB_A, 'rg-app'), rgPath(SUB_B, 'RG-App'), rgPath(SUB_C, 'rg-app')],
      });
    });

    it('stores a name-only group found in 500 subscriptions as a Scope set holding all 500 paths', async () => {
      await everything();
      for (let n = 0; n < 500; n++) await finding(sub(n), 'rg-wide');
      await dashboard('conv-wide', { widgets: [], filters: { resourceGroups: ['rg-wide'] } });

      await h().startUp();

      const { dimensionFilters } = await config('conv-wide');
      expect(dimensionFilters!.scope).toBeUndefined();
      const paths = await scopeSetPaths(dimensionFilters!.scopeSet as string);
      expect(paths).toHaveLength(500);
      expect(paths[0]).toBe(rgPath(sub(0), 'rg-wide'));
      expect(paths[499]).toBe(rgPath(sub(499), 'rg-wide'));
    });

    it('keeps a name no record pairs with a subscription, and a resource group under the Directory, as unresolved picks', async () => {
      await everything();
      await recordPairs();
      await dashboard('conv-missing', { widgets: [], filters: { resourceGroups: ['rg-gone'] } });
      await dashboard('conv-directory', { widgets: [], filters: { subscriptions: ['Directory'], resourceGroups: ['rg-app'] } });
      await dashboard('conv-some', { widgets: [], filters: { resourceGroups: ['rg-gone', 'rg-data'] } });

      await h().startUp();

      const picks = async (id: string) => (await config(id)).dimensionFilters!.scope as string[];
      expect(await picks('conv-missing')).toEqual(['unresolved:resourceGroup/rg-gone']);
      expect(await picks('conv-directory')).toEqual(['unresolved:@directory/rg-app']);
      // The unresolved name stays beside the one that resolved, and neither list is ever empty.
      expect(await picks('conv-some')).toEqual([rgPath(SUB_A, 'rg-data'), 'unresolved:resourceGroup/rg-gone']);
      for (const id of ['conv-missing', 'conv-directory']) {
        for (const pick of await picks(id)) expect(parseScope(pick)).toBeNull();
      }
    });

    it('shows the pairs a person does not hold by count, never by name', async () => {
      await everything();
      await recordPairs();
      await dashboard('conv-access', { widgets: [], filters: { resourceGroups: ['rg-app'] } });
      await h().startUp();
      const picks = (await config('conv-access')).dimensionFilters!.scope as string[];
      const holdsA: Access = buildAccess([{ tenantId: 't', scope: parseScope(`/subscriptions/${SUB_A}`)!, role: 'viewer' }], 'manual');

      const chips = scopeChips(scopePickStates(holdsA, picks, []));

      expect(chips.map(c => c.label)).toEqual([`rg-app in ${SUB_A}`, '2 Scopes outside your access']);
      expect(chips.map(c => c.label).join()).not.toContain(SUB_B);
    });

    it('converts again when the legacy values changed since, as a save under 0.13 does, and not before', async () => {
      await everything();
      await dashboard('conv-rollback', { widgets: WIDGETS, filters: { subscriptions: [SUB_A], tags: ['old'] } });
      await h().startUp();
      const converted = await config('conv-rollback');
      expect(converted.dimensionFilters).toEqual({ scope: [`/subscriptions/${SUB_A}`], tags: ['old'] });

      // 0.13 reads the legacy values, the person changes them, and its save keeps the new shape it does not know.
      await h().run(`UPDATE dashboards SET config = ${lit(JSON.stringify({ ...converted, filters: { subscriptions: [SUB_B] } }))} WHERE id = 'conv-rollback'`);
      await h().startUp();

      const again = await config('conv-rollback');
      expect(again.dimensionFilters).toEqual({ scope: [`/subscriptions/${SUB_B}`] });
      expect(again.filters).toEqual({ subscriptions: [SUB_B] });
      expect(again.convertedFrom).toEqual({ filters: { subscriptions: [SUB_B] } });
      expect(again.widgets).toEqual(WIDGETS);
    });

    it('converts to no filters when 0.13 cleared every legacy value, rather than keeping the filters it was converted from', async () => {
      await everything();
      await dashboard('conv-cleared', { widgets: [], filters: { subscriptions: [SUB_A] } });
      await h().startUp();
      const converted = await config('conv-cleared');
      await h().run(`UPDATE dashboards SET config = ${lit(JSON.stringify({ ...converted, filters: {} }))} WHERE id = 'conv-cleared'`);

      await h().startUp();

      expect((await config('conv-cleared')).dimensionFilters).toEqual({});
    });

    it('logs a dashboard whose config cannot be read and still converts the rest, and starts up without throwing', async () => {
      await everything();
      await h().run(`INSERT INTO dashboards (id, name, config, is_default, created_at) VALUES ('conv-broken', 'conv-broken', 'not json', false, '2026-01-01T00:00:00.000Z')`);
      await dashboard('conv-fine', { widgets: [], filters: { subscriptions: [SUB_A] } });
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await expect(h().startUp()).resolves.toBeUndefined();
        expect(logged.mock.calls.map(c => String(c[0])).join('\n')).toContain('conv-broken');
      } finally {
        logged.mockRestore();
      }

      expect((await config('conv-fine')).dimensionFilters).toEqual({ scope: [`/subscriptions/${SUB_A}`] });
      expect((await h().all(`SELECT config FROM dashboards WHERE id = 'conv-broken'`))[0]!.config).toBe('not json');
    });

    it('writes no audit entry', async () => {
      await everything();
      await dashboard('conv-audit', { widgets: [], filters: { subscriptions: [SUB_A] } });
      await savedView('conv-audit-view', `subscription=${SUB_A}`);
      await h().startUp();
      const count = async () => (await h().all(`SELECT COUNT(*) AS n FROM audit_log`))[0]!.n;
      const before = Number(await count());

      await h().startUp();

      expect(Number(await count())).toBe(before);
      expect(await h().all(`SELECT id FROM audit_log WHERE summary LIKE '%conv-audit%'`)).toEqual([]);
    });

    it('changes nothing on a second start', async () => {
      await everything();
      await recordPairs();
      for (let n = 0; n < 500; n++) await finding(sub(n), 'rg-wide');
      await dashboard('conv-idem-a', { widgets: WIDGETS, filters: { subscriptions: [SUB_A], resourceGroups: ['rg-app'], categories: ['c'] }, windowDays: 1 });
      await dashboard('conv-idem-b', { widgets: [], filters: { resourceGroups: ['rg-wide'] } });
      await savedView('conv-idem-v', `severity=high&subscription=${SUB_A}&rg=rg-app`);
      await h().startUp();
      const read = async () => ({
        dashboards: await h().all(`SELECT id, config FROM dashboards WHERE id LIKE 'conv-idem-%' ORDER BY id`),
        views: await h().all(`SELECT id, query FROM saved_views ORDER BY id`),
        sets: await h().all(`SELECT hash, paths, created_at FROM scope_sets ORDER BY hash`),
      });
      const first = await read();
      expect(first.sets).toHaveLength(1);

      await h().startUp();

      expect(await read()).toEqual(first);
    });
  });

  describe('saved views', () => {
    it('adds the Scope picks beside the legacy subscription and resource group params, leaving the rest of the query as written', async () => {
      await everything();
      await savedView('conv-view', `severity=high&subscription=${SUB_A}&rg=rg-x&q=storage&window=30`);

      await h().startUp();

      const stored = await query('conv-view');
      const params = new URLSearchParams(stored);
      expect(stored.startsWith(`severity=high&subscription=${SUB_A}&rg=rg-x&q=storage&window=30&`)).toBe(true);
      expect(params.get('scope')).toBe(rgPath(SUB_A, 'rg-x'));
      expect(params.get('subscription')).toBe(SUB_A);
      expect(params.get('rg')).toBe('rg-x');
    });

    it('converts a name-only resource group to the pairs on record, and an unmatched one to an unresolved pick', async () => {
      await everything();
      await recordPairs();
      await savedView('conv-view-name', 'rg=rg-data%2Crg-gone');

      await h().startUp();

      expect(new URLSearchParams(await query('conv-view-name')).get('scope'))
        .toBe(`${rgPath(SUB_A, 'rg-data')},unresolved:resourceGroup/rg-gone`);
    });

    it('writes a Scope set for a name-only group found in 500 subscriptions, and the query fits the limit', async () => {
      await everything();
      for (let n = 0; n < 500; n++) await finding(sub(n), 'rg-wide');
      await savedView('conv-view-wide', 'rg=rg-wide&status=all');

      await h().startUp();

      const stored = await query('conv-view-wide');
      const params = new URLSearchParams(stored);
      expect(params.has('scope')).toBe(false);
      expect(stored.length).toBeLessThanOrEqual(MAX_SAVED_VIEW_QUERY_LENGTH);
      expect(await scopeSetPaths(params.get('scopeset')!)).toHaveLength(500);
      expect(params.get('rg')).toBe('rg-wide');
    });

    it('keeps an unresolved pick in the Scope set a long saved view list becomes, and a long all-unresolved list as a set too', async () => {
      await everything();
      for (let n = 0; n < 60; n++) await finding(sub(n), 'rg-wide');
      await savedView('conv-view-mixed', 'rg=rg-wide%2Crg-gone');
      const names = Array.from({ length: 80 }, (_, n) => `rg-missing-${String(n).padStart(3, '0')}`);
      await savedView('conv-view-missing', `severity=high&rg=${names.join('%2C')}`);

      await h().startUp();

      const mixed = new URLSearchParams(await query('conv-view-mixed'));
      const mixedPaths = await scopeSetPaths(mixed.get('scopeset')!);
      expect(mixed.has('scope')).toBe(false);
      expect(mixedPaths).toHaveLength(61);
      expect(mixedPaths).toContain('unresolved:resourceGroup/rg-gone');
      const missing = new URLSearchParams(await query('conv-view-missing'));
      expect(missing.get('severity')).toBe('high');
      expect(missing.has('scope')).toBe(false);
      expect(await scopeSetPaths(missing.get('scopeset')!)).toEqual(names.map(n => `unresolved:resourceGroup/${n}`));
    });

    it('leaves a query that has a Scope, or neither list, exactly as it was', async () => {
      await everything();
      await recordPairs();
      await savedView('conv-view-scoped', `subscription=${SUB_A}&scope=${encodeURIComponent(`/subscriptions/${SUB_B}`)}`);
      await savedView('conv-view-set', `rg=rg-app&scopeset=${'a'.repeat(64)}`);
      await savedView('conv-view-none', 'severity=high&status=all');
      await savedView('conv-view-empty', '');

      await h().startUp();

      expect(await query('conv-view-scoped')).toBe(`subscription=${SUB_A}&scope=${encodeURIComponent(`/subscriptions/${SUB_B}`)}`);
      expect(await query('conv-view-set')).toBe(`rg=rg-app&scopeset=${'a'.repeat(64)}`);
      expect(await query('conv-view-none')).toBe('severity=high&status=all');
      expect(await query('conv-view-empty')).toBe('');
    });
  });
}
