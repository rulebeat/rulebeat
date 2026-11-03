/**
 * The shared filter model in lib/finding-view.ts, driven through its public functions only: the
 * seven filter dimensions and the Scans age field as they travel in an address (`viewToSearchParams`,
 * `encodeView`, `viewFromSearchParams`), and the link helper (`findingsLink`) for widget
 * click-throughs. Seams: the address in and out, and the link out.
 */
import { describe, expect, it } from 'vitest';
import { dateWindowLabel } from '@/lib/date-window';
import {
  SCOPE_INLINE_BUDGET, emptyView, encodeView, findingsLink, viewFromSearchParams, viewToSearchParams,
  type FindingsLink, type View,
} from '@/lib/finding-view';

const NOW = new Date('2026-11-03T12:00:00Z');
const SUB1 = '/subscriptions/11111111-1111-1111-1111-111111111111';
const SUB2 = '/subscriptions/22222222-2222-2222-2222-222222222222';
const MG = '/providers/Microsoft.Management/managementGroups/Contoso';
const HASH = 'a'.repeat(64);

function view(overrides: Partial<View> = {}): View {
  return { ...emptyView(), ...overrides };
}

const read = (query: string, opts: { overBase?: boolean } = {}) => viewFromSearchParams(new URLSearchParams(query), { ...opts, limitWindow: true, now: NOW });
const text = (v: View) => viewToSearchParams(v).toString();

describe('the seven dimensions and age in the address', () => {
  it('writes each dimension under its settled param name', () => {
    const params = viewToSearchParams(view({
      filters: [
        { field: 'category', values: ['security'] }, { field: 'rule', values: ['r1', 'r2'] },
        { field: 'severity', values: ['high'] }, { field: 'tags', values: ['framework:iso27001'] },
      ],
      scope: [SUB1, '@directory'], source: ['aprl-v2', 'custom'], age: { min: 31, max: 90 },
      window: { mode: 'relative', days: 30 },
    }));
    expect(params.get('category')).toBe('security');
    expect(params.get('ruleId')).toBe('r1,r2');
    expect(params.get('severity')).toBe('high');
    expect(params.get('tags')).toBe('framework:iso27001');
    expect(params.get('scope')).toBe(`${SUB1},@directory`);
    expect(params.get('source')).toBe('aprl-v2,custom');
    expect(params.get('age')).toBe('31-90');
    expect(params.get('window')).toBe('30');
    expect(params.has('scopeset')).toBe(false);
  });

  it('writes a custom range as from and to, and leaves the default window out', () => {
    expect(viewToSearchParams(view({ window: { mode: 'custom', from: '2026-10-01', to: '2026-10-20' } })).toString()).toBe('from=2026-10-01&to=2026-10-20');
    expect(text(view({ window: { mode: 'relative', days: 7 } }))).toBe('');
  });

  it('never reads or writes suppressed=', () => {
    expect(read('suppressed=1&category=security')).toEqual(view({ filters: [{ field: 'category', values: ['security'] }] }));
    expect(text(view())).not.toContain('suppressed');
    expect(viewToSearchParams(read('suppressed=1')).has('suppressed')).toBe(false);
  });

  it('keeps the casing of a scope path and drops a repeat that differs only by case', () => {
    const v = read(`scope=${SUB1},${SUB1.toUpperCase()},${MG}`);
    expect(v.scope).toEqual([SUB1, MG]);
  });

  it('escapes the delimiters in a scope, source and rule value and reads them back', () => {
    const awkward = ['a,b', 'c|d', 'e=f', 'g\\h'];
    const v = view({ scope: awkward, source: awkward, filters: [{ field: 'rule', values: awkward }] });
    const back = read(text(v));
    expect(back.scope).toEqual(awkward);
    expect(back.source).toEqual(awkward);
    expect(back.filters).toEqual([{ field: 'rule', values: awkward }]);
  });

  it('reads the page handed over as a plain object', () => {
    const v = viewFromSearchParams({ tab: 'results', scope: SUB1, source: 'custom', age: '0-7' }, { now: NOW });
    expect(v.scope).toEqual([SUB1]);
    expect(v.source).toEqual(['custom']);
    expect(v.age).toEqual({ min: 0, max: 7 });
  });
});

describe('age=MIN-MAX', () => {
  it('reads a closed and an open range', () => {
    expect(read('age=31-90').age).toEqual({ min: 31, max: 90 });
    expect(read('age=91-').age).toEqual({ min: 91, max: null });
    expect(text(view({ age: { min: 91, max: null } }))).toBe('age=91-');
  });

  it('ignores a malformed range instead of throwing', () => {
    for (const bad of ['age=abc', 'age=-5', 'age=90-31', 'age=1.5-3', 'age=1-2-3', 'age=5', 'age=99999999-']) {
      expect(read(bad).age, bad).toBeUndefined();
    }
  });
});

describe('an empty value', () => {
  const EMPTY = 'category=&ruleId=&severity=&tags=&scope=&source=&age=';

  it('reads as absent on a plain address', () => {
    expect(read(EMPTY)).toEqual(emptyView());
  });

  it('reads as Any over a base, and is written back as an empty value', () => {
    const v = read(EMPTY, { overBase: true });
    expect(v.filters).toEqual([
      { field: 'rule', values: [] }, { field: 'category', values: [] }, { field: 'severity', values: [] }, { field: 'tags', values: [] },
    ]);
    expect(v.scope).toEqual([]);
    expect(v.source).toEqual([]);
    expect(v.age).toBeNull();
    const params = viewToSearchParams(v);
    for (const name of ['category', 'ruleId', 'severity', 'tags', 'scope', 'source', 'age']) {
      expect(params.has(name), name).toBe(true);
      expect(params.get(name), name).toBe('');
    }
  });

  it('is not Any when a value was typed that no known value matches', () => {
    expect(read('severity=bogus', { overBase: true }).filters).toEqual([]);
  });

  it('does not make an Any of an empty window or scope set', () => {
    const v = read('window=&from=&to=&scopeset=', { overBase: true });
    expect(v.window).toEqual({ mode: 'relative', days: 7 });
    expect(v.scopeSet).toBeUndefined();
  });
});

describe('the date window', () => {
  it('keeps window=N for 1 to 365 and labels it Nd', () => {
    for (const days of [1, 45, 365]) {
      const v = read(`window=${days}`);
      expect(v.window).toEqual({ mode: 'relative', days });
      expect(v.windowShortened).toBeUndefined();
    }
    expect(dateWindowLabel(read('window=45').window)).toBe('45d');
    expect(dateWindowLabel(read('window=365').window)).toBe('365d');
  });

  it('reads window above 365 as 365 and says it was shortened', () => {
    const v = read('window=900');
    expect(v.window).toEqual({ mode: 'relative', days: 365 });
    expect(v.windowShortened).toBe(true);
    expect(text(v)).toBe('window=365');
  });

  it('leaves the window alone unless asked to limit it, so a link with a wider one still opens as written', () => {
    const plain = (query: string) => viewFromSearchParams(new URLSearchParams(query), { now: NOW });
    expect(plain('window=3650').window).toEqual({ mode: 'relative', days: 3650 });
    expect(plain('from=2020-01-01&to=2020-02-01').window).toEqual({ mode: 'custom', from: '2020-01-01', to: '2020-02-01' });
    expect(plain('window=3650').windowShortened).toBeUndefined();
  });

  it('defaults to 7d when the window is missing, zero or not a whole number', () => {
    for (const q of ['', 'window=0', 'window=-2', 'window=2.5', 'window=abc']) {
      expect(read(q).window, q).toEqual({ mode: 'relative', days: 7 });
    }
  });

  it('keeps a custom range inside 365 days back', () => {
    const v = read('from=2025-11-04&to=2026-10-30');
    expect(v.window).toEqual({ mode: 'custom', from: '2025-11-04', to: '2026-10-30' });
    expect(v.windowShortened).toBeUndefined();
  });

  it('clamps a custom range reaching past 365 days back, and says so', () => {
    const v = read('from=2024-01-01&to=2026-10-30');
    expect(v.window).toEqual({ mode: 'custom', from: '2025-11-03', to: '2026-10-30' });
    expect(v.windowShortened).toBe(true);
  });

  it('clamps a custom range that lies wholly past the limit', () => {
    const v = read('from=2023-01-01&to=2023-02-01');
    expect(v.window).toEqual({ mode: 'custom', from: '2025-11-03', to: '2025-11-03' });
    expect(v.windowShortened).toBe(true);
  });
});

describe('a long Scope list', () => {
  const many = Array.from({ length: 40 }, (_, i) => `${SUB1}/resourceGroups/resource-group-number-${i}`);

  it('is never written inline, and the encoder says it needs a scope set', () => {
    const v = view({ scope: many });
    expect(many.join(',').length).toBeGreaterThan(SCOPE_INLINE_BUDGET);
    const { params, needsScopeSet } = encodeView(v);
    expect(needsScopeSet).toBe(true);
    expect(params.has('scope')).toBe(false);
    expect(params.has('scopeset')).toBe(false);
    expect(text(v)).not.toContain('scope');
  });

  it('writes scopeset= when given one', () => {
    const { params, needsScopeSet } = encodeView(view({ scope: many, scopeSet: HASH }));
    expect(needsScopeSet).toBe(false);
    expect(params.get('scopeset')).toBe(HASH);
    expect(params.has('scope')).toBe(false);
  });

  it('writes a list within the budget inline and needs no set', () => {
    const { params, needsScopeSet } = encodeView(view({ scope: many.slice(0, 3) }));
    expect(needsScopeSet).toBe(false);
    expect(params.get('scope')).toBe(many.slice(0, 3).join(','));
  });

  it('measures the budget on what is written, escapes included', () => {
    const commas = ['a,'.repeat(600)];
    expect(encodeView(view({ scope: commas })).needsScopeSet).toBe(true);
  });

  it('reads scopeset= as a reference, lower-cased, and ignores one that is not a sha256', () => {
    expect(read(`scopeset=${HASH.toUpperCase()}`).scopeSet).toBe(HASH);
    expect(read('scopeset=nothex').scopeSet).toBeUndefined();
    expect(read(`scope=${SUB1}&scopeset=${HASH}`).scope).toBeUndefined();
  });

  it('needs no set when there is no list', () => {
    expect(encodeView(view()).needsScopeSet).toBe(false);
    expect(encodeView(view({ scope: [] })).needsScopeSet).toBe(false);
  });
});

describe('round trip', () => {
  const longScope = Array.from({ length: 60 }, (_, i) => `${SUB1}/resourceGroups/rg-${i}`);
  const CASES: Record<string, { v: View; overBase?: boolean }> = {
    empty: { v: emptyView() },
    'every dimension': {
      v: view({
        filters: [
          { field: 'rule', values: ['r1'] }, { field: 'category', values: ['security', 'cost'] },
          { field: 'severity', values: ['critical'] }, { field: 'tags', values: ['a b', 'c,d'] },
          { field: 'status', values: ['new'] },
        ],
        scope: [SUB1, MG, '@directory'], source: ['rulebeat-core', 'community'], age: { min: 31, max: 90 },
        window: { mode: 'relative', days: 90 },
      }),
    },
    'backslash escapes': {
      v: view({ filters: [{ field: 'tags', values: ['back\\slash', 'p|q', 'x=y', 'a,b'] }], scope: ['/x/a\\b'], source: ['s\\,t'] }),
    },
    'open age and custom window': { v: view({ age: { min: 91, max: null }, window: { mode: 'custom', from: '2026-10-01', to: '2026-10-20' } }) },
    '@directory only': { v: view({ scope: ['@directory'] }) },
    'scope set': { v: view({ scopeSet: HASH, filters: [{ field: 'severity', values: ['high'] }] }) },
    'the Any marker': {
      v: view({
        filters: [
          { field: 'rule', values: [] }, { field: 'category', values: [] }, { field: 'severity', values: [] }, { field: 'tags', values: [] },
        ],
        scope: [], source: [], age: null,
      }),
      overBase: true,
    },
    'Any beside values': { v: view({ scope: [], source: ['custom'], age: { min: 0, max: 7 }, filters: [{ field: 'category', values: [] }] }), overBase: true },
    'a long scope list that was given a set': { v: view({ scope: longScope, scopeSet: HASH }) },
  };

  for (const [name, { v, overBase }] of Object.entries(CASES)) {
    it(`is identical written, read and written again: ${name}`, () => {
      const first = viewToSearchParams(v).toString();
      const second = viewToSearchParams(viewFromSearchParams(new URLSearchParams(first), { overBase, limitWindow: true, now: NOW })).toString();
      expect(second).toBe(first);
      expect(first.length).toBeLessThan(8 * 1024);
    });
  }

  it('keeps every address under 8 KB even when a Scope list is far over budget', () => {
    const huge = Array.from({ length: 2000 }, (_, i) => `${SUB1}/resourceGroups/resource-group-with-a-long-name-${i}`);
    expect(viewToSearchParams(view({ scope: huge })).toString().length).toBeLessThan(8 * 1024);
    expect(viewToSearchParams(view({ scope: huge, scopeSet: HASH })).toString().length).toBeLessThan(8 * 1024);
  });

  it('writes the Any marker only where the filter is one of the seven', () => {
    expect(text(view({ filters: [{ field: 'location', values: [] }, { field: 'subscription', values: [] }] }))).toBe('');
  });
});

describe('findingsLink', () => {
  const link = (l: FindingsLink) => {
    if (l.kind !== 'link') throw new Error(`expected a link, got ${l.kind}`);
    const url = new URL(l.href, 'http://x');
    return { path: url.pathname, params: url.searchParams };
  };

  it('opens the Results tab with the widget filters when the metric adds nothing', () => {
    const { path, params } = link(findingsLink(
      { category: ['security'], severity: ['high'], rule: ['r1'], source: ['custom'], tags: ['t'], scope: [SUB1], window: { mode: 'relative', days: 30 } },
      {},
    ));
    expect(path).toBe('/scans');
    expect(params.get('tab')).toBe('results');
    expect(params.get('category')).toBe('security');
    expect(params.get('severity')).toBe('high');
    expect(params.get('ruleId')).toBe('r1');
    expect(params.get('source')).toBe('custom');
    expect(params.get('tags')).toBe('t');
    expect(params.get('scope')).toBe(SUB1);
    expect(params.get('window')).toBe('30');
  });

  it('adds status, tab and q as given', () => {
    const { params } = link(findingsLink({}, {}, { tab: 'advisories', status: 'fixed', q: 'vm 1' }));
    expect(params.get('tab')).toBe('advisories');
    expect(params.get('status')).toBe('fixed');
    expect(params.get('q')).toBe('vm 1');
  });

  it('takes the metric value alone where the widget filter is absent or Any', () => {
    expect(link(findingsLink({}, { severity: ['critical'] })).params.get('severity')).toBe('critical');
    expect(link(findingsLink({ severity: [] }, { severity: ['critical'] })).params.get('severity')).toBe('critical');
    expect(link(findingsLink({ severity: ['high'] }, {})).params.get('severity')).toBe('high');
  });

  it('intersects severity, category and rule, in the order the widget filter lists them', () => {
    const { params } = link(findingsLink(
      { severity: ['high', 'critical', 'low'], category: ['security', 'cost'], rule: ['r1', 'r2'] },
      { severity: ['critical', 'low', 'medium'], category: ['cost'], rule: ['r2', 'r3'] },
    ));
    expect(params.get('severity')).toBe('critical,low');
    expect(params.get('category')).toBe('cost');
    expect(params.get('ruleId')).toBe('r2');
  });

  it('reports an empty intersection as outside the filters, naming the dimension', () => {
    const result = findingsLink({ severity: ['high'], category: ['cost'] }, { severity: ['critical'], category: ['security'] });
    expect(result).toEqual({ kind: 'outside-filters', dimensions: ['category', 'severity'] });
  });

  it('gives a subscription under a management group pick as that subscription', () => {
    const hierarchy = { contains: (mg: string, path: string) => mg.toLowerCase() === MG.toLowerCase() && path.toLowerCase() === SUB1.toLowerCase() };
    expect(link(findingsLink({ scope: [MG] }, { scope: [SUB1] }, { hierarchy })).params.get('scope')).toBe(SUB1);
    expect(findingsLink({ scope: [MG] }, { scope: [SUB2] }, { hierarchy })).toEqual({ kind: 'outside-filters', dimensions: ['scope'] });
  });

  it('gives the resource group picks inside a subscription as those picks', () => {
    const rgA = `${SUB1}/resourceGroups/rg-a`;
    const rgB = `${SUB1}/resourceGroups/RG-B`;
    const rgOther = `${SUB2}/resourceGroups/rg-c`;
    const { params } = link(findingsLink({ scope: [rgA, rgB, rgOther] }, { scope: [SUB1.toUpperCase()] }));
    expect(params.get('scope')).toBe(`${rgA},${rgB}`);
  });

  it('gives a resource group metric inside a subscription pick as the resource group', () => {
    const rgA = `${SUB1}/resourceGroups/rg-a`;
    expect(link(findingsLink({ scope: [SUB1] }, { scope: [rgA] })).params.get('scope')).toBe(rgA);
  });

  it('matches equal scope paths whatever their case, keeping the metric spelling', () => {
    expect(link(findingsLink({ scope: [SUB1.toUpperCase()] }, { scope: [SUB1] })).params.get('scope')).toBe(SUB1);
  });

  it('does not read a management group as holding anything it was not told it holds', () => {
    expect(findingsLink({ scope: [MG] }, { scope: [SUB1] }).kind).toBe('outside-filters');
  });

  it('keeps the Directory only against the Directory', () => {
    expect(link(findingsLink({ scope: ['@directory', SUB1] }, { scope: ['@DIRECTORY'] })).params.get('scope')).toBe('@DIRECTORY');
    expect(findingsLink({ scope: [SUB1] }, { scope: ['@directory'] }).kind).toBe('outside-filters');
  });

  it('lets a metric window replace the widget window, and intersects age', () => {
    const { params } = link(findingsLink(
      { window: { mode: 'relative', days: 30 }, age: { min: 0, max: 90 } },
      { window: { mode: 'relative', days: 1 }, age: { min: 31, max: null } },
    ));
    expect(params.get('window')).toBe('1');
    expect(params.get('age')).toBe('31-90');
    expect(findingsLink({ age: { min: 0, max: 7 } }, { age: { min: 31, max: null } }).kind).toBe('outside-filters');
  });

  it('asks for a scope set rather than writing a long list inline', () => {
    const many = Array.from({ length: 40 }, (_, i) => `${SUB1}/resourceGroups/resource-group-number-${i}`);
    const result = findingsLink({ scope: many }, {});
    expect(result).toEqual({ kind: 'needs-scope-set', scope: many });
    const given = link(findingsLink({ scope: many }, {}, { scopeSet: HASH }));
    expect(given.params.get('scopeset')).toBe(HASH);
    expect(given.params.has('scope')).toBe(false);
  });

  it('never writes suppressed=', () => {
    expect(link(findingsLink({ severity: ['high'] }, {}, { status: 'all' })).params.has('suppressed')).toBe(false);
  });
});
