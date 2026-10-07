/**
 * Ticket #165: a rule saved from "Duplicate" on the rule page records where it came from. The form
 * saves through POST /api/rules, so the route is where the origin is decided: from the source rule as
 * the server stores it, never from the request. A hand-written request cannot invent an origin, a
 * version or a retirement for a custom rule.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { dbReady, pgDb, rawSqlite } from '@/lib/db/client';
import { dbKind } from '@/lib/db/backend';
import { runSeeds } from '@/lib/db/migrate';
import { seedPg } from '@/lib/db/pg/seeds';
import { loadRecordedVersions } from '@/lib/db/recorded-versions';
import { duplicateRule, loadRule, loadRules } from '@/lib/rules';
import { describeOrigin } from '@/lib/rule-version-markers';
import type { ShippedCatalogue } from '@/lib/shipped-catalogue';
import { catalogueOf, shippedRule } from '../helpers/catalogue';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

vi.mock('@/lib/azure-credential', () => ({
  createTenantContext: () => Promise.reject(new Error('not configured in this test file')),
}));

const { POST } = await import('@/app/api/rules/route');

const dataDir = mkdtempSync(join(tmpdir(), 'rb-copy-origin-'));
const SRC = 'copy-origin-src';

async function seed(catalogue: ShippedCatalogue): Promise<void> {
  await dbReady;
  if (dbKind === 'pg') await seedPg(pgDb!, dataDir, { skipOwnerBootstrap: true, catalogue });
  else runSeeds(rawSqlite!, dataDir, { skipOwnerBootstrap: true, catalogue });
}

const shipped = (version: string, name = 'Copy origin source') => shippedRule({ id: SRC, version, definition: { name } });

let counter = 0;
function body(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `copy origin test rule ${++counter}`,
    description: 'a test rule',
    category: 'security',
    severity: 'medium',
    enabled: false,
    scope: { level: 'subscription' },
    resourceTypes: [],
    conditions: [],
    ...extra,
  };
}

async function post(payload: Record<string, unknown>): Promise<{ status: number; rule: Record<string, unknown> }> {
  const res = await POST(new Request('http://localhost/api/rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }));
  return { status: res.status, rule: await res.json() };
}

/** What the database holds for a created rule, not what the response echoed. */
async function stored(id: unknown) {
  const rule = await loadRule(String(id));
  if (!rule) throw new Error(`rule ${String(id)} was not stored`);
  return { version: rule.version, retiredAt: rule.retiredAt, originRuleId: rule.originRuleId, originVersion: rule.originVersion };
}

describe('POST /api/rules records the origin of a copy', () => {
  beforeEach(async () => {
    await resetDb();
    mockAuth.mockReset();
    const result = await createUser({ email: 'editor@example.com', role: 'editor' });
    if ('error' in result) throw new Error(result.error);
    await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
    mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
    await seed(catalogueOf(shipped('1.0.0')));
  });

  it('copied from a shipped rule: records its id and the version it runs, and a newer release then shows', async () => {
    const { status, rule } = await post(body({ copyFrom: SRC }));
    expect(status).toBe(201);
    expect(await stored(rule.id)).toEqual({ version: undefined, retiredAt: undefined, originRuleId: SRC, originVersion: '1.0.0' });

    await seed(catalogueOf(shipped('1.1.0', 'Copy origin source v2')));
    const rules = await loadRules();
    expect(describeOrigin(rules.find(r => r.id === rule.id)!, rules, await loadRecordedVersions())).toMatchObject({
      kind: 'duplicate', originRuleId: SRC, version: '1.0.0', hasNewerVersion: true,
    });
  });

  it('records the same origin as duplicating the rule from the Library does', async () => {
    const viaRoute = await post(body({ copyFrom: SRC }));
    const viaLibrary = (await duplicateRule(SRC))!;
    const a = await stored(viaRoute.rule.id);
    expect([a.originRuleId, a.originVersion]).toEqual([viaLibrary.originRuleId, viaLibrary.originVersion]);
  });

  it('copied from a copy: keeps the origin the first copy had', async () => {
    const first = await post(body({ copyFrom: SRC }));
    const second = await post(body({ copyFrom: first.rule.id }));
    expect(await stored(second.rule.id)).toMatchObject({ originRuleId: SRC, originVersion: '1.0.0' });
  });

  it('copied from a custom rule that has no origin: records none', async () => {
    const plain = await post(body());
    const copy = await post(body({ copyFrom: plain.rule.id }));
    expect(copy.status).toBe(201);
    expect(await stored(copy.rule.id)).toMatchObject({ originRuleId: undefined, originVersion: undefined });
  });

  it('an unknown copyFrom records no origin and still creates the rule', async () => {
    const { status, rule } = await post(body({ copyFrom: 'no-such-rule' }));
    expect(status).toBe(201);
    expect(await stored(rule.id)).toMatchObject({ originRuleId: undefined, originVersion: undefined });
  });

  it('a copyFrom that is not a string is ignored', async () => {
    const { status, rule } = await post(body({ copyFrom: { id: SRC } }));
    expect(status).toBe(201);
    expect(await stored(rule.id)).toMatchObject({ originRuleId: undefined, originVersion: undefined });
  });
});

describe('POST /api/rules ignores version, retirement and origin sent by the client', () => {
  beforeEach(async () => {
    await resetDb();
    mockAuth.mockReset();
    const result = await createUser({ email: 'editor@example.com', role: 'editor' });
    if ('error' in result) throw new Error(result.error);
    await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
    mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
    await seed(catalogueOf(shipped('1.0.0')));
  });

  const forged = { version: '9.9.9', retiredAt: '2026-01-01T00:00:00.000Z', originRuleId: SRC, originVersion: '0.0.1' };

  it('stores none of them for a rule with no copyFrom', async () => {
    const { status, rule } = await post(body(forged));
    expect(status).toBe(201);
    expect(await stored(rule.id)).toEqual({ version: undefined, retiredAt: undefined, originRuleId: undefined, originVersion: undefined });
    // The 201 body is the stored rule too, not an echo of the request.
    for (const field of ['version', 'retiredAt', 'originRuleId', 'originVersion']) expect(rule).not.toHaveProperty(field);
  });

  it('records the source rule as the server has it, not the origin the request claims', async () => {
    const { rule } = await post(body({ ...forged, originRuleId: 'something-else', copyFrom: SRC }));
    expect(await stored(rule.id)).toEqual({ version: undefined, retiredAt: undefined, originRuleId: SRC, originVersion: '1.0.0' });
  });
});
