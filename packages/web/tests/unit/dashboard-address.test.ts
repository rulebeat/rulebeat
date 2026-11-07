/**
 * The address of a dashboard's filter changes (ADR 0013): a layer of differences from the saved
 * filters, one param per dimension, written with the /scans param names. A present param replaces
 * the saved value, a missing one inherits it, and an empty one is the explicit "any".
 */
import { describe, expect, it } from 'vitest';
import {
  dashboardAddress, viewFromSearchParams, viewToSearchParams, type DashboardFilters,
} from '@/lib/finding-view';

const SAVED: DashboardFilters = {
  category: ['security'],
  subscription: ['sub-1', 'sub-2'],
  resourceGroup: ['rg-a'],
  tags: ['prod'],
  rule: ['rule-1'],
  severity: ['critical', 'high'],
  window: { mode: 'relative', days: 30 },
};

const address = dashboardAddress(SAVED);
const read = (query: string) => address.read(new URLSearchParams(query));
const write = (changes: ReturnType<typeof read>) => address.write(changes).toString();
const pairs = (query: string) => [...new URLSearchParams(query)].map(([k, v]) => `${k}=${v}`).sort();

describe('reading a layer of filter changes', () => {
  it('inherits every dimension from an address that names none', () => {
    expect(read('')).toEqual({});
    expect(read('tab=results&page=2')).toEqual({});
  });

  it('replaces a dimension with the values the param holds', () => {
    expect(read('severity=low%2Cmedium&tags=dev')).toEqual({ severity: ['low', 'medium'], tags: ['dev'] });
  });

  it('reads an empty param as the explicit any', () => {
    expect(read('severity=&subscription=')).toEqual({ severity: [], subscription: [] });
  });

  it('reads a param whose every value is unknown as inherit, never as any', () => {
    expect(read('severity=bogus')).toEqual({});
    expect(read('severity=bogus%2Cnope')).toEqual({});
    expect(read('tags=%2C')).toEqual({});
    expect(read('window=0')).toEqual({});
    expect(read('window=soon')).toEqual({});
    expect(read('from=2026-01-01')).toEqual({});
    expect(read('from=yesterday&to=today')).toEqual({});
  });

  it('keeps the good values of a param and ignores the malformed ones', () => {
    expect(read('severity=bogus%2Chigh')).toEqual({ severity: ['high'] });
    expect(read('tags=a%2C%2Cb')).toEqual({ tags: ['a', 'b'] });
  });

  it('reads a relative window, and a custom one before it', () => {
    expect(read('window=7')).toEqual({ window: { mode: 'relative', days: 7 } });
    expect(read('from=2026-01-01&to=2026-01-31&window=7')).toEqual({ window: { mode: 'custom', from: '2026-01-01', to: '2026-01-31' } });
  });

  it('never reads includeSuppressed, nor any param that is not a dashboard dimension', () => {
    expect(read('suppressed=1&includeSuppressed=true&status=new&q=vm&location=westeurope&f=kind%3Dadvisory')).toEqual({});
  });
});

describe('writing a layer of filter changes', () => {
  it('writes a dimension that differs from the saved one under its /scans param name', () => {
    expect(pairs(write({ category: ['identity'], subscription: ['sub-9'], resourceGroup: ['rg-b'], tags: ['dev'], rule: ['rule-2'], severity: ['low'] }))).toEqual(
      pairs('category=identity&subscription=sub-9&rg=rg-b&tags=dev&ruleId=rule-2&severity=low'),
    );
  });

  it('writes nothing for a dimension equal to its saved value, ignoring order and duplicates', () => {
    expect(write({ severity: ['high', 'critical'], subscription: ['sub-2', 'sub-1', 'sub-2'], category: ['security'] })).toBe('');
  });

  it('writes the explicit any as an empty param, and nothing when the saved value is already any', () => {
    expect(write({ severity: [] })).toBe('severity=');
    expect(dashboardAddress({ ...SAVED, severity: [] }).write({ severity: [] }).toString()).toBe('');
  });

  it('writes each value once and escapes the list delimiter', () => {
    expect(read(write({ tags: ['a,b', 'c', 'c'] }))).toEqual({ tags: ['a,b', 'c'] });
  });

  it('writes a window whenever it differs from the saved one, even at the 7-day default', () => {
    expect(write({ window: { mode: 'relative', days: 7 } })).toBe('window=7');
    expect(write({ window: { mode: 'relative', days: 30 } })).toBe('');
    expect(write({ window: { mode: 'custom', from: '2026-01-01', to: '2026-01-31' } })).toBe('from=2026-01-01&to=2026-01-31');
    expect(dashboardAddress({ ...SAVED, window: { mode: 'relative', days: 7 } }).write({ window: { mode: 'relative', days: 7 } }).toString()).toBe('');
  });

  it('keeps the params the page owns first, and drops a stale dimension param it replaces or no longer needs', () => {
    const out = address.write({ severity: ['low'] }, new URLSearchParams('tab=overview&severity=high&tags=prod&window=3'));
    expect(pairs(out.toString())).toEqual(pairs('tab=overview&severity=low'));
    expect(out.toString().startsWith('tab=overview')).toBe(true);
  });

  it('drops the params that carry includeSuppressed from the base, so it never appears in an address', () => {
    const out = address.write({ severity: ['low'] }, new URLSearchParams('tab=overview&suppressed=1&includeSuppressed=true'));
    expect(out.toString()).toBe('tab=overview&severity=low');
  });

  it('never writes includeSuppressed', () => {
    const changes = { ...read('severity=low'), includeSuppressed: true } as ReturnType<typeof read>;
    expect(write(changes)).toBe('severity=low');
  });
});

describe('the address round trip', () => {
  const CHANGES: Record<string, string> = {
    'a replaced value list': 'category=identity&subscription=sub-9&rg=rg-b&tags=dev&ruleId=rule-2&severity=low',
    'the any marker on every dimension': 'category=&subscription=&rg=&tags=&ruleId=&severity=',
    'a window equal to the 7-day default': 'window=7',
    'a custom window': 'from=2026-01-01&to=2026-01-31',
    'a value with a delimiter in it': 'tags=a%5C%2Cb%2Cc',
  };

  it.each(Object.entries(CHANGES))('reads back exactly what it writes: %s', (_name, query) => {
    expect(pairs(write(read(query)))).toEqual(pairs(query));
    expect(read(write(read(query)))).toEqual(read(query));
  });

  it('drops a malformed value on the next write', () => {
    expect(pairs(write(read('severity=bogus%2Chigh&tags=zzz')))).toEqual(pairs('severity=high&tags=zzz'));
  });

  it('reads an address back to the dimensions it was written from', () => {
    const changes = { severity: ['low'], tags: [], window: { mode: 'relative' as const, days: 7 } };
    expect(read(write(changes))).toEqual(changes);
  });
});

describe('plain /scans reading and writing', () => {
  it('still drops an empty value, so an empty param is no filter there', () => {
    expect(viewFromSearchParams(new URLSearchParams('severity=&tags=&f=kind%3D')).filters).toEqual([]);
  });

  it('still writes only what restricts, with no any marker', () => {
    const view = viewFromSearchParams(new URLSearchParams('severity=&window=7'));
    expect(viewToSearchParams(view).toString()).toBe('');
  });
});
