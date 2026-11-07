/**
 * #388: the one options read behind the shared filter component (`GET /api/filters/options`). It lists every
 * category; the Rule source values with the label the manifest gives, else the built-in pack label, else the id,
 * and Community and Custom; every tag on any rule; the severities in ramp order; every rule on the install with
 * Disabled and Retired flagged and Personal rules left out; the held Scope tree, with the Directory for whoever
 * holds it; and where the findings the viewer sees are placed, for the column funnels. Real repositories over the
 * access matrix's seed; only the session is mocked.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import {
  MATRIX_TENANT, SCOPE_MANAGEMENT_GROUP, SCOPE_RESOURCE_GROUP, SCOPE_SUBSCRIPTION, SUB_ONE, SUB_TWO,
  createPeople, matrixHierarchy, seedMatrix,
} from '../helpers/access-matrix';
import { EVERYTHING_ACCESS } from '../helpers/access';
import { createUser } from '@/lib/db/users';
import { createPersonalRule } from '@/lib/db/personal-rules';
import { createCategory } from '@/lib/db/categories';
import { saveRules } from '@/lib/rules';
import { readFilterOptions } from '@/lib/db/filter-options';
import { refreshFrom } from '../helpers/fake-hierarchy';
import { refreshManagementGroupHierarchy } from '@/lib/management-group-hierarchy';
import { packSourceLabel, ruleOptionLabel } from '@/lib/filter-options';
import type { Rule } from '@rulebeat/core';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
const { GET } = await import('@/app/api/filters/options/route');

const ruleRow = (id: string, extra: Partial<Rule>): Rule => ({
  id, name: id, description: 'a rule', category: 'security', severity: 'high', enabled: true, type: 'custom',
  scope: { level: 'subscription' }, resourceTypes: [], conditions: [], rawKql: 'resources | project id', ...extra,
} as Rule);

let ids: Record<string, string>;

beforeAll(async () => {
  await resetDb();
  ids = await createPeople();
  await seedMatrix();
  await createCategory({ label: 'Networking', color: '#123456' } as never);
  await saveRules([
    ruleRow('core-rule', { name: 'Core rule', type: 'builtin', tags: ['framework:iso', 'pci'] }),
    ruleRow('aprl-rule', { name: 'APRL rule', type: 'builtin', pack: 'aprl-v2', category: 'reliability', tags: ['framework:iso'] }),
    ruleRow('aprl-retired', { name: 'Retired APRL rule', type: 'builtin', pack: 'aprl-v2', retiredAt: '2026-05-01T00:00:00.000Z' }),
    ruleRow('community-rule', { name: 'Community rule', type: 'community', enabled: false }),
    ruleRow('custom-rule', { name: 'Custom rule', type: 'custom', tags: ['mine'] }),
    ruleRow('unknown-pack-rule', { name: 'Unknown pack rule', type: 'builtin', pack: 'zzz-pack' }),
  ]);
  const author = await createUser({ email: 'author@example.com', role: 'editor' });
  if ('error' in author) throw new Error(author.error);
  await createPersonalRule(author.user.id, {
    name: 'A personal rule', description: 'd', category: 'security', severity: 'low', queryBackend: 'resource-graph', kind: 'state',
    scope: { level: 'subscription' }, resourceTypes: [], conditions: [], rawKql: 'resources', tags: ['personal-only-tag'],
  } as never);
});

describe('readFilterOptions', () => {
  it('lists every category in its order, with or without findings', async () => {
    const options = await readFilterOptions(EVERYTHING_ACCESS);
    expect(options.categories.map(c => c.label)).toContain('Networking');
    expect(options.categories.map(c => c.id)).toEqual(expect.arrayContaining(['security', 'cost', 'identity', 'reliability', 'compliance']));
  });

  it('lists the Rule sources: each pack a rule carries by its label, then Community and Custom', async () => {
    const { sources } = await readFilterOptions(EVERYTHING_ACCESS);
    expect(sources).toEqual([
      { value: 'rulebeat-core', label: 'RuleBeat Core' },
      { value: 'aprl-v2', label: 'APRL v2' },
      { value: 'zzz-pack', label: 'zzz-pack' },
      { value: 'community', label: 'Community' },
      { value: 'custom', label: 'Custom' },
    ]);
  });

  it('lists every tag on any rule once, and none from a Personal rule', async () => {
    const { tags } = await readFilterOptions(EVERYTHING_ACCESS);
    expect(tags).toEqual(['framework:iso', 'mine', 'pci']);
  });

  it('lists the severities in ramp order', async () => {
    expect((await readFilterOptions(EVERYTHING_ACCESS)).severities).toEqual(['critical', 'high', 'medium', 'low', 'info']);
  });

  it('lists every rule install-wide, Disabled and Retired flagged, and no Personal rule', async () => {
    const { rules } = await readFilterOptions(EVERYTHING_ACCESS);
    expect(rules.find(r => r.id === 'core-rule')).toEqual({ id: 'core-rule', name: 'Core rule', category: 'security', disabled: false, retired: false });
    expect(rules.find(r => r.id === 'community-rule')).toMatchObject({ disabled: true, retired: false });
    expect(rules.find(r => r.id === 'aprl-retired')).toMatchObject({ disabled: false, retired: true });
    expect(rules.map(r => r.name)).not.toContain('A personal rule');
    expect(rules.map(r => r.name)).toEqual([...rules.map(r => r.name)].sort((a, b) => a.localeCompare(b)));
  });

  it('lists rules with no findings, for a person who holds no Scope as well', async () => {
    const { rules } = await readFilterOptions({ ...EVERYTHING_ACCESS, everything: false, grants: [], directory: false });
    expect(rules.map(r => r.id)).toEqual(expect.arrayContaining(['core-rule', 'aprl-rule', 'custom-rule']));
  });

  it('answers the held Scope tree: Everything holds the whole of it, from the tenant root, and the Directory', async () => {
    const { scopes } = await readFilterOptions(EVERYTHING_ACCESS);
    expect(scopes.listing).toBe('listed');
    expect(scopes.directory).toBe(true);
    expect(scopes.tree.map(i => [i.name, (i.children ?? []).map(c => c.name)])).toEqual([['Tenant Root Group', ['Example group']]]);
  });

  it('answers where the findings the viewer sees are placed, for the column funnels', async () => {
    const { placements } = await readFilterOptions(EVERYTHING_ACCESS);
    expect(placements.subscriptions.sort()).toEqual(['directory', SUB_ONE, SUB_TWO].sort());
    expect(placements.resourceGroups).toEqual(expect.arrayContaining([
      { subscription: SUB_ONE, name: 'rg-one' }, { subscription: SUB_ONE, name: 'rg-two' }, { subscription: SUB_TWO, name: 'rg-one' },
    ]));
    expect(placements.resourceGroups).toHaveLength(3);
  });
});

describe('the options a scoped viewer gets', () => {
  const access = async (person: string) => {
    const { resolveAccess } = await import('@/lib/access');
    const { getUser } = await import('@/lib/db/users');
    return resolveAccess((await getUser(ids[person]!))!);
  };

  it('a subscription holder gets their subscription alone, its resource groups, and no Directory', async () => {
    const { scopes, placements } = await readFilterOptions(await access('Viewer on one subscription'));
    expect(scopes.directory).toBe(false);
    expect(scopes.tree.map(i => [i.key, (i.children ?? []).map(c => c.name)])).toEqual([[SCOPE_SUBSCRIPTION, ['rg-one', 'rg-two']]]);
    expect(placements).toEqual({ subscriptions: [SUB_ONE], resourceGroups: [{ subscription: SUB_ONE, name: 'rg-one' }, { subscription: SUB_ONE, name: 'rg-two' }] });
  });

  it('a resource group holder gets the subscription with the one group', async () => {
    const { scopes } = await readFilterOptions(await access('Viewer on one resource group'));
    expect(scopes.tree.map(i => [i.key, (i.children ?? []).map(c => c.key)])).toEqual([[SCOPE_SUBSCRIPTION, [SCOPE_RESOURCE_GROUP]]]);
  });

  it('a management group holder gets the group and both subscriptions under it, and not the tenant root', async () => {
    const { scopes } = await readFilterOptions(await access('Viewer on the management group'));
    expect(scopes.tree.map(i => [i.key, (i.children ?? []).map(c => c.name)])).toEqual([[SCOPE_MANAGEMENT_GROUP, ['Subscription one', 'Subscription two']]]);
    expect(JSON.stringify(scopes)).not.toContain(MATRIX_TENANT);
  });

  it('the Directory holder gets the Directory and no tree', async () => {
    const { scopes, placements } = await readFilterOptions(await access('Directory only'));
    expect(scopes).toMatchObject({ directory: true, tree: [] });
    expect(placements).toEqual({ subscriptions: ['directory'], resourceGroups: [] });
  });

  it('a person with no Scope gets an empty picker but the same categories, tags and rules', async () => {
    const options = await readFilterOptions(await access('No Scope'));
    expect(options.scopes).toMatchObject({ directory: false, tree: [] });
    expect(options.placements).toEqual({ subscriptions: [], resourceGroups: [] });
    expect(options.tags).toEqual(['framework:iso', 'mine', 'pci']);
  });
});

describe('the listing', () => {
  it('is failed when the stored tree has never been read, and listed after a refresh', async () => {
    await resetDb();
    ids = await createPeople();
    expect((await readFilterOptions(EVERYTHING_ACCESS)).scopes.listing).toBe('failed');
    await refreshFrom(matrixHierarchy());
    expect((await readFilterOptions(EVERYTHING_ACCESS)).scopes.listing).toBe('listed');
    const failing = matrixHierarchy();
    failing.failWith = new Error('boom');
    expect((await refreshManagementGroupHierarchy({ read: failing.read })).ok).toBe(false);
    const after = await readFilterOptions(EVERYTHING_ACCESS);
    expect(after.scopes.listing).toBe('failed');
    expect(after.scopes.tree.length).toBeGreaterThan(0);
  });
});

describe('packSourceLabel', () => {
  it('prefers the manifest label, then the built-in pack label, then the id', () => {
    const manifest = { 'aprl-v2': { label: 'From the manifest' }, 'no-label': {} };
    expect(packSourceLabel('aprl-v2', manifest)).toBe('From the manifest');
    expect(packSourceLabel('cis-azure', manifest)).toBe('CIS Azure');
    expect(packSourceLabel('no-label', manifest)).toBe('no-label');
    expect(packSourceLabel('other', manifest)).toBe('other');
  });
});

describe('ruleOptionLabel', () => {
  it('says a rule that is retired or disabled is, so it is never listed as if it ran', () => {
    expect(ruleOptionLabel({ name: 'Rule', disabled: false, retired: false })).toBe('Rule');
    expect(ruleOptionLabel({ name: 'Rule', disabled: true, retired: false })).toBe('Rule (Disabled)');
    expect(ruleOptionLabel({ name: 'Rule', disabled: false, retired: true })).toBe('Rule (Retired)');
    expect(ruleOptionLabel({ name: 'Rule', disabled: true, retired: true })).toBe('Rule (Retired, Disabled)');
  });
});

describe('GET /api/filters/options', () => {
  it('answers 401 for nobody signed in', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it('answers the read for the signed-in person under their own access', async () => {
    await resetDb();
    ids = await createPeople();
    await seedMatrix();
    mockAuth.mockResolvedValue({ user: { uid: ids['Viewer on one subscription'] } });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as Awaited<ReturnType<typeof readFilterOptions>>;
    expect(body.scopes.tree.map(i => i.key)).toEqual([SCOPE_SUBSCRIPTION]);
    expect(body.severities).toEqual(['critical', 'high', 'medium', 'low', 'info']);
  });

  it('a removed person loses it at once', async () => {
    const { deleteUser } = await import('@/lib/db/users');
    mockAuth.mockResolvedValue({ user: { uid: ids['No Scope'] } });
    expect((await GET()).status).toBe(200);
    await deleteUser(ids['No Scope']!);
    expect((await GET()).status).toBe(401);
  });
});

