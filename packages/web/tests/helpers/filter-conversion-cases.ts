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
  describe('widget overrides and periods', () => {
    const widget = (id: string, type: string, cfg: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      ({ id, type, title: id, x: 0, y: 0, w: 4, h: 3, config: cfg, ...extra });
    type StoredWidget = { id: string; type: string; config?: Record<string, unknown>; dimensionFilters?: Record<string, unknown> };
    const widgetsOf = async (id: string) => (await config(id)).widgets as StoredWidget[];
    const dims = async (id: string) => Object.fromEntries((await widgetsOf(id)).map(w => [w.id, w.dimensionFilters]));
    const days = (n: number) => ({ window: { mode: 'relative', days: n } });

    it('converts each period of a trend: All time is 365 days, no period is 30, and the rest keep their length', async () => {
      await everything();
      await dashboard('conv-w-trend', { widgets: [
        widget('a', 'trend', { period: '7d' }), widget('b', 'trend', { period: '30d' }), widget('c', 'trend', { period: '90d' }),
        widget('d', 'trend', { period: 'all' }), widget('e', 'trend', {}), widget('f', 'trend', { period: 'fortnight' }),
      ] });

      await h().startUp();

      expect(await dims('conv-w-trend')).toEqual({ a: days(7), b: days(30), c: days(90), d: days(365), e: days(30), f: days(30) });
    });

    it('converts All history on New vs Fixed and Activity occurrences to 180 days, and no period to 30', async () => {
      await everything();
      await dashboard('conv-w-events', { widgets: [
        widget('a', 'new-vs-fixed', { period: 'all' }), widget('b', 'new-vs-fixed', {}), widget('c', 'new-vs-fixed', { period: '90d' }),
        widget('d', 'activity-occurrences', { period: 'all' }), widget('e', 'activity-occurrences', {}), widget('f', 'activity-occurrences', { period: '7d' }),
      ] });

      await h().startUp();

      expect(await dims('conv-w-events')).toEqual({ a: days(180), b: days(30), c: days(90), d: days(180), e: days(30), f: days(7) });
    });

    it('converts a widget windowDays of 1, 7 or 30 and ignores any other, and gives no period to a widget that does not read one', async () => {
      await everything();
      await dashboard('conv-w-days', { widgets: [
        widget('a', 'stat-card', { metric: 'new-findings', windowDays: 1 }), widget('b', 'stat-card', { metric: 'new-findings', windowDays: 7 }),
        widget('c', 'top-rules', { windowDays: 30 }), widget('d', 'top-rules', { windowDays: 90 }),
        widget('e', 'severity-breakdown', { period: '7d' }), widget('f', 'severity-breakdown', {}),
      ] });

      await h().startUp();

      expect(await dims('conv-w-days')).toEqual({ a: days(1), b: days(7), c: days(30), d: undefined, e: undefined, f: undefined });
    });

    it('lets the period win over windowDays on the three chart types, and keeps windowDays when there is no period', async () => {
      await everything();
      await dashboard('conv-w-wins', { widgets: [
        widget('a', 'trend', { period: '90d', windowDays: 7 }), widget('b', 'new-vs-fixed', { windowDays: 1 }),
        widget('c', 'activity-occurrences', { period: 'all', windowDays: 30 }),
      ] });

      await h().startUp();

      expect(await dims('conv-w-wins')).toEqual({ a: days(90), b: days(30), c: days(180) });
    });

    it('turns a widget category into a one-value pick, and category all and empty lists into Inherit', async () => {
      await everything();
      await dashboard('conv-w-category', { widgets: [
        widget('a', 'severity-breakdown', { category: 'cost' }), widget('b', 'severity-breakdown', { category: 'all' }),
        widget('c', 'top-rules', { category: 'all', policyIds: [], subscriptions: [], tags: [] }),
        widget('d', 'posture-ring', { category: 'security', policyIds: ['r1', 'r2'] }),
      ] });

      await h().startUp();

      expect(await dims('conv-w-category')).toEqual({ a: { category: ['cost'] }, b: undefined, c: undefined, d: { category: ['security'], rule: ['r1', 'r2'] } });
    });

    it('converts only limit, category and policyIds of a findings-table widget, and writes no rename back', async () => {
      await everything();
      const legacy = widget('a', 'findings-table', {
        limit: 5, category: 'cost', policyIds: ['r1'], subscriptions: [SUB_A], period: '7d', windowDays: 1, tags: ['t'],
      });
      const explorer = widget('b', 'findings-explorer', { limit: 9, category: 'all', policyIds: ['r2'], windowDays: 30 });
      await dashboard('conv-w-table', { widgets: [legacy, explorer] });

      await h().startUp();

      const stored = await config('conv-w-table');
      expect(await dims('conv-w-table')).toEqual({ a: { category: ['cost'], rule: ['r1'] }, b: { rule: ['r2'] } });
      expect((stored.widgets as StoredWidget[]).map(w => [w.type, w.config])).toEqual([[legacy.type, legacy.config], [explorer.type, explorer.config]]);
      expect(stored.convertedFrom).toEqual({ widgets: { a: { category: 'cost', policyIds: ['r1'] }, b: { category: 'all', policyIds: ['r2'] } } });
    });

    it('converts an old top-policies widget as top-rules and leaves its type as stored', async () => {
      await everything();
      await dashboard('conv-w-policies', { widgets: [widget('a', 'top-policies', { limit: 8, category: 'cost', policyIds: ['r9'] }), widget('b', 'top-policies', { limit: 8 })] });

      await h().startUp();

      expect(await dims('conv-w-policies')).toEqual({ a: { category: ['cost'], rule: ['r9'] }, b: undefined });
      expect((await widgetsOf('conv-w-policies')).map(w => w.type)).toEqual(['top-policies', 'top-policies']);
    });

    it('does not convert a widget-level filters or layout, which 0.13 never read', async () => {
      await everything();
      await dashboard('conv-w-unread', { widgets: [widget('a', 'top-rules', { limit: 3 }, { filters: { categories: ['cost'] }, layout: { x: 1, y: 2, w: 3, h: 4 } })] });
      const before = (await h().all(`SELECT config FROM dashboards WHERE id = 'conv-w-unread'`))[0]!.config;

      await h().startUp();

      expect((await h().all(`SELECT config FROM dashboards WHERE id = 'conv-w-unread'`))[0]!.config).toBe(before);
    });

    it('records the legacy values per widget id, never its type or metric, and writes them beside the untouched legacy keys', async () => {
      await everything();
      const trend = widget('t1', 'trend', { category: 'cost', period: 'all', windowDays: 7, chartType: 'area', policyIds: ['r1'] });
      const card = widget('c1', 'stat-card', { metric: 'new-findings', windowDays: 7 });
      await dashboard('conv-w-record', { widgets: [trend, card, widget('plain', 'stat-card', { metric: 'total-findings' })], filters: { tags: ['t'] } });

      await h().startUp();

      const stored = await config('conv-w-record');
      expect(stored.convertedFrom).toEqual({
        filters: { tags: ['t'] },
        widgets: { t1: { category: 'cost', policyIds: ['r1'], period: 'all', windowDays: 7 }, c1: { windowDays: 7 } },
      });
      expect((stored.widgets as StoredWidget[]).map(w => w.config)).toEqual([trend.config, card.config, { metric: 'total-findings' }]);
    });

    it('leaves a dashboard shaped like the 25-06 fixture row exactly as it was: widgets with a layout and no config', async () => {
      await everything();
      const fixture = {
        widgets: [
          { id: 'w1', type: 'stat-card', layout: { x: 0, y: 0, w: 3, h: 2 } },
          { id: 'w2', type: 'top-policies', layout: { x: 3, y: 0, w: 6, h: 4 } },
        ],
        filters: { category: 'cost', dateWindow: { mode: 'relative', days: 7 } },
      };
      await dashboard('conv-w-2506', fixture as unknown as DashboardConfigJson);
      const before = (await h().all(`SELECT config FROM dashboards WHERE id = 'conv-w-2506'`))[0]!.config;

      await h().startUp();

      expect((await h().all(`SELECT config FROM dashboards WHERE id = 'conv-w-2506'`))[0]!.config).toBe(before);
    });

    it('still converts the widgets that have a config on a dashboard that also holds one with none', async () => {
      await everything();
      await dashboard('conv-w-mixed', { widgets: [{ id: 'a', type: 'stat-card' }, widget('b', 'trend', { period: '90d' })] });

      await h().startUp();

      expect(await dims('conv-w-mixed')).toEqual({ a: undefined, b: days(90) });
      expect((await widgetsOf('conv-w-mixed'))[0]).toEqual({ id: 'a', type: 'stat-card' });
    });

    it('converts a widget again when 0.13 edited its legacy values, and leaves the widgets it did not edit as they are', async () => {
      await everything();
      await dashboard('conv-w-rollback', { widgets: [widget('a', 'severity-breakdown', { category: 'cost' }), widget('b', 'trend', { period: '7d' })] });
      await h().startUp();
      const converted = await config('conv-w-rollback');
      const [a, b] = converted.widgets as StoredWidget[];
      // The person tunes widget b in the new shape, then goes back to 0.13 and edits widget a, whose save keeps the keys it does not know.
      const tuned = { ...converted, widgets: [{ ...a, config: { category: 'security', policyIds: ['r1'] } }, { ...b, dimensionFilters: days(90) }] };
      await h().run(`UPDATE dashboards SET config = ${lit(JSON.stringify(tuned))} WHERE id = 'conv-w-rollback'`);

      await h().startUp();

      const again = await config('conv-w-rollback');
      expect(await dims('conv-w-rollback')).toEqual({ a: { category: ['security'], rule: ['r1'] }, b: days(90) });
      expect(again.convertedFrom).toEqual({ widgets: { a: { category: 'security', policyIds: ['r1'] }, b: { period: '7d' } } });
    });

    it('clears a widget override when 0.13 cleared the legacy value it came from', async () => {
      await everything();
      await dashboard('conv-w-cleared', { widgets: [widget('a', 'severity-breakdown', { category: 'cost' })] });
      await h().startUp();
      const converted = await config('conv-w-cleared');
      const [a] = converted.widgets as StoredWidget[];
      await h().run(`UPDATE dashboards SET config = ${lit(JSON.stringify({ ...converted, widgets: [{ ...a, config: { category: 'all' } }] }))} WHERE id = 'conv-w-cleared'`);

      await h().startUp();

      expect(await dims('conv-w-cleared')).toEqual({ a: undefined });
    });

    it('converts a widget added under 0.13 and ignores the record of one that was deleted', async () => {
      await everything();
      await dashboard('conv-w-added', { widgets: [widget('a', 'severity-breakdown', { category: 'cost' }), widget('gone', 'top-rules', { category: 'cost' })] });
      await h().startUp();
      const converted = await config('conv-w-added');
      const [a] = converted.widgets as StoredWidget[];
      await h().run(`UPDATE dashboards SET config = ${lit(JSON.stringify({ ...converted, widgets: [a, widget('new', 'new-vs-fixed', { period: 'all' })] }))} WHERE id = 'conv-w-added'`);

      await h().startUp();

      expect(await dims('conv-w-added')).toEqual({ a: { category: ['cost'] }, new: days(180) });
    });

    it('changes nothing on a second start', async () => {
      await everything();
      await dashboard('conv-w-idem', { widgets: [
        widget('a', 'trend', {}), widget('b', 'findings-table', { policyIds: ['r1'], category: 'cost' }), widget('c', 'stat-card', { metric: 'new-findings', windowDays: 7 }),
        widget('d', 'new-vs-fixed', { period: 'all' }), { id: 'e', type: 'stat-card' },
      ], filters: { subscriptions: [SUB_A] } });
      await dashboard('conv-w-idem-bare', { widgets: [widget('a', 'trend', {})] });
      await h().startUp();
      const read = async () => h().all(`SELECT id, config FROM dashboards WHERE id LIKE 'conv-w-idem%' ORDER BY id`);
      const first = await read();

      await h().startUp();

      expect(await read()).toEqual(first);
    });
  });
}
