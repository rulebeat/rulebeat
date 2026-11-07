/**
 * The Rules tab's address is its state (#402): a /scans?tab=rules link opens the list it describes, and the
 * address the filter controls write opens that same list again. Driven from the page (`searchParams` in,
 * `rulesQuery` and `ruleList` out) through the function the client writes the address with, for every
 * parameter the tab reads, so the page's searchParams and the client's URL sync cannot drift.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUser } from '@/lib/db/users';
import { saveRules } from '@/lib/rules';
import { rulesQueryFromSearchParams, rulesQueryToSearchParams, type RulesTabQuery } from '@/lib/rules-tab-query';
import type { RulesTabList } from '@/lib/rules-tab-list';
import { resetDb } from '../helpers/db';
import type { Rule } from '@rulebeat/core';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
const { default: ScansPage } = await import('@/app/(app)/scans/page');

const ruleOf = (id: string, over: Record<string, unknown> = {}): Rule => ({
  id, name: id, description: 'a test rule', category: 'security', severity: 'medium', enabled: true, type: 'custom',
  scope: { level: 'subscription' }, resourceTypes: [], conditions: [], rawKql: 'resources | project id', ...over,
} as unknown as Rule);

beforeEach(async () => {
  await resetDb();
  const admin = await createUser({ email: 'admin@example.com', role: 'admin' });
  if ('error' in admin) throw new Error(admin.error);
  mockAuth.mockResolvedValue({ user: { uid: admin.user.id } });
  await saveRules([
    ruleOf('core-high', { severity: 'high', type: 'builtin', pack: 'rulebeat-core', tags: ['prod'] }),
    ruleOf('aprl-low', { category: 'network', severity: 'low', type: 'builtin', pack: 'aprl-v2', tags: ['pci'], kind: 'advisory' }),
    ruleOf('custom-off', { category: 'network', severity: 'high', enabled: false, tags: ['dev'] }),
    ruleOf('activity-rule', { queryBackend: 'log-analytics', logsQuery: { kql: 'SigninLogs', timeWindowDays: 7 } }),
  ]);
});

function scansClientProps(node: ReactNode): Record<string, unknown> {
  const queue: ReactNode[] = [node];
  while (queue.length > 0) {
    const next = queue.shift();
    if (Array.isArray(next)) { queue.push(...next); continue; }
    if (!isValidElement(next)) continue;
    const props = (next as ReactElement<Record<string, unknown>>).props;
    if ('activeTab' in props) return props;
    queue.push(props.children as ReactNode);
  }
  throw new Error('ScansClient not rendered');
}

/** What Next hands the page for a query string: a repeated param is an array. */
function searchParamsOf(query: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(query)) {
    const held = out[key];
    out[key] = held === undefined ? value : [...(Array.isArray(held) ? held : [held]), value];
  }
  return out;
}

async function open(query: string) {
  const props = scansClientProps(await ScansPage({ searchParams: Promise.resolve(searchParamsOf(query)) }));
  return { rulesQuery: props.rulesQuery as RulesTabQuery, list: props.ruleList as RulesTabList | undefined };
}

const pairs = (query: string) => [...new URLSearchParams(query)].map(([k, v]) => `${k}=${v}`).sort();
const listed = (list: RulesTabList | undefined) => list?.entries.map(e => e.id).sort();

// One link for each parameter the Rules tab reads, and one that holds them all.
const LINKS: Record<string, { query: string; ids: string[] }> = {
  category: { query: 'tab=rules&category=network', ids: ['aprl-low', 'custom-off'] },
  source: { query: 'tab=rules&source=aprl-v2', ids: ['aprl-low'] },
  tags: { query: 'tab=rules&tags=prod,dev', ids: ['core-high', 'custom-off'] },
  severity: { query: 'tab=rules&severity=high', ids: ['core-high', 'custom-off'] },
  kind: { query: 'tab=rules&kind=advisory', ids: ['aprl-low'] },
  outcome: { query: 'tab=rules&outcome=unknown', ids: ['activity-rule', 'aprl-low', 'core-high'] },
  'rules=enabled': { query: 'tab=rules&rules=enabled', ids: ['activity-rule', 'aprl-low', 'core-high'] },
  'rules=disabled': { query: 'tab=rules&rules=disabled', ids: ['custom-off'] },
  subscription: { query: 'tab=rules&subscription=00000000-0000-0000-0000-00000000000a', ids: ['activity-rule', 'aprl-low', 'core-high', 'custom-off'] },
  'subscription=directory': { query: 'tab=rules&subscription=directory', ids: ['activity-rule', 'aprl-low', 'core-high', 'custom-off'] },
  'rg with its subscription': { query: 'tab=rules&subscription=00000000-0000-0000-0000-00000000000a&rg=rg-one', ids: ['activity-rule', 'aprl-low', 'core-high', 'custom-off'] },
  managementGroup: { query: 'tab=rules&managementGroup=mg-example', ids: ['activity-rule', 'aprl-low', 'core-high', 'custom-off'] },
  'all of them': {
    query: 'tab=rules&category=network&source=aprl-v2,custom&tags=pci&severity=low&kind=advisory&outcome=unknown&rules=enabled'
      + '&subscription=00000000-0000-0000-0000-00000000000a&rg=rg-one&managementGroup=mg-example',
    ids: ['aprl-low'],
  },
  'no rules filter': { query: 'tab=rules', ids: ['activity-rule', 'aprl-low', 'core-high', 'custom-off'] },
};

describe.each(Object.entries(LINKS))('a Rules link with %s', (_name, { query, ids }) => {
  it('lists the rules the address describes, decided on the server', async () => {
    const { list } = await open(query);
    expect(listed(list)).toEqual(ids);
  });

  it('hands the client the query the address holds', async () => {
    const { rulesQuery } = await open(query);
    expect(rulesQuery).toEqual(rulesQueryFromSearchParams(new URLSearchParams(query)));
  });

  it('is written back to the address exactly as it came, by the function the client writes it with', async () => {
    const { rulesQuery } = await open(query);
    const rewritten = rulesQueryToSearchParams(rulesQuery, new URLSearchParams('tab=rules')).toString();
    expect(pairs(rewritten)).toEqual(pairs(query));
  });

  it('opens the same list again from the address the client wrote', async () => {
    const first = await open(query);
    const written = rulesQueryToSearchParams(first.rulesQuery, new URLSearchParams('tab=rules')).toString();
    const second = await open(written);
    expect(second.rulesQuery).toEqual(first.rulesQuery);
    expect(listed(second.list)).toEqual(listed(first.list));
  });
});

describe('the Rules tab outside its own tab', () => {
  it('sends no list, since the server computes it for ?tab=rules only', async () => {
    const { list } = await open('tab=results&kind=advisory');
    expect(list).toBeUndefined();
  });

  it('lists every rule for an address that predates the new params', async () => {
    const { list } = await open('tab=rules&category=network');
    expect(listed(list)).toEqual(['aprl-low', 'custom-off']);
  });
});

describe('the client and the page share one reader and one writer', () => {
  const read = (file: string) => readFileSync(path.resolve(__dirname, '../..', file), 'utf8');

  it('reads the address with rulesQueryFromSearchParams and writes it with rulesQueryToSearchParams', () => {
    expect(read('app/(app)/scans/page.tsx')).toContain('rulesQueryFromSearchParams(params)');
    expect(read('components/modules/scans-client.tsx')).toContain('rulesQueryToSearchParams(next');
  });

  it('keeps no filter state of the list in the browser: only free-text search', () => {
    const client = read('components/modules/scans-client.tsx');
    for (const gone of ['setTagFilter', 'setSeverityFilter', 'setStatusFilter', 'setCategoryFilter']) expect(client).not.toContain(gone);
    expect(client).toContain('const [search, setSearch]');
  });
});
