/**
 * Trust in dashboard numbers (map #320): every posture input refreshes today's trend points, and nothing
 * that is not an input does. The table drives each repository write the spec names through the real
 * function and asserts that the point for today was rewritten after the write (its update time is the
 * clock at the write, which a point that was not refreshed cannot have), and that the counts moved the way
 * the write says.
 *
 * Also the structural guards: no repository writer skips the refresh, no route or scheduler path passes
 * `now` to the writer, and the writer reads only on its transaction.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, dbReady, rawSqlite, pgDb } from '@/lib/db/client';
import { run } from '@/lib/db/exec';
import { ruleVersions } from '@/lib/db/tables';
import { runSeeds } from '@/lib/db/migrate';
import { seedPg } from '@/lib/db/pg/seeds';
import { getCategory } from '@/lib/db/categories';
import { runCategoryScan } from '@/lib/scan-runner';
import { refreshSnapshotsFor, backfillSnapshots } from '@/lib/db/snapshots';
import { listFindings, deleteFindingsForRule } from '@/lib/db/findings';
import { createRule, deleteRule, duplicateRule, saveRules, setRulesEnabled, switchRuleVersion, updateRule } from '@/lib/rules';
import { approveLibraryRequest, copyPersonalRuleToLibrary, createLibraryRequest } from '@/lib/db/library-requests';
import { createPersonalRule } from '@/lib/db/personal-rules';
import { createUser } from '@/lib/db/users';
import { addSuppression, removeSuppression, saveSuppressions } from '@/lib/suppressions';
import { refreshExpiredSuppressions, tickOnce } from '@/lib/scheduler';
import { clearRules, execRaw, resetDb } from '../helpers/db';
import { EVERYTHING_ACCESS } from '../helpers/access';
import { argRow, fakeTenantContext } from '../helpers/fake-azure';
import { catalogueOf, shippedRule } from '../helpers/catalogue';
import { fakeHierarchy, group, refreshFrom, subscription } from '../helpers/fake-hierarchy';
import { insertRuleRow, pointOn, storeFindings, syntheticFinding } from '../helpers/trend-writer';
import type { Rule } from '@/lib/types';

const WEB = path.resolve(__dirname, '../..');
const SUB = '0a000000-0000-4000-8000-00000000000a';
const T0 = '2026-05-04T08:00:00.000Z';
const T1 = '2026-05-04T09:00:00.000Z';
const DAY = '2026-05-04';

/** Runs `fn` with the clock reading `iso`, so a refresh it causes writes the day and update time of `iso`. */
async function atClock<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
  try { return await fn(); } finally { vi.useRealTimers(); }
}

const SWITCHED = 'aaaaaaaa-0000-4000-8000-0000000000d1';
const v1 = shippedRule({ id: SWITCHED });
const v2 = shippedRule({ id: SWITCHED, version: '2.0.0', releaseNote: 'Moved.', definition: { category: 'cost' } });

/** A shipped rule in Security that has a recorded second version which belongs to Cost, seeded without a refresh. */
async function seedSwitchableRule(): Promise<void> {
  await dbReady;
  await run(db.delete(ruleVersions).where(eq(ruleVersions.ruleId, SWITCHED)));
  const dataDir = path.join(WEB, 'data');
  for (const catalogue of [catalogueOf(v1), catalogueOf(v2)]) {
    if (pgDb) await seedPg(pgDb, dataDir, { skipOwnerBootstrap: true, catalogue });
    else runSeeds(rawSqlite!, dataDir, { skipOwnerBootstrap: true, catalogue });
  }
}

/** A scan of Security whose one rule returns two resources, so the sync opens two findings and resolves the stored one. */
async function scanSecurity(): Promise<void> {
  const category = (await getCategory('security'))!;
  const ctx = fakeTenantContext({ rows: () => [argRow({ name: 'a' }), argRow({ name: 'b' })] });
  await runCategoryScan(category, { access: EVERYTHING_ACCESS, ctx, ruleIds: ['r1'] });
}

const newRule = (id: string, over: Partial<Rule> = {}): Rule => ({
  id, name: `New rule ${id}`, description: 'a rule', category: 'security', severity: 'medium', enabled: true, type: 'custom',
  scope: { level: 'subscription' }, resourceTypes: [], conditions: [], rawKql: 'resources | project id', ...over,
} as unknown as Rule);

let requesters = 0;

/** An open library request from a new author: a new rule, or an edit of `targetRuleId`, with the definition's category. */
async function personalRuleOf(category: string) {
  requesters += 1;
  const author = await createUser({ email: `inputs-author-${requesters}@example.com`, role: 'editor' });
  if ('error' in author) throw new Error(author.error);
  const personal = await createPersonalRule(author.user.id, {
    name: `Requested rule ${requesters}`, description: '', category, severity: 'high', queryBackend: 'resource-graph', kind: 'state',
    scope: { level: 'subscription' }, resourceTypes: [], conditions: [], rawKql: 'resources | project id',
  });
  return { author: author.user, personal };
}

async function openRequest(category: string, targetRuleId?: string): Promise<string> {
  const { author, personal } = await personalRuleOf(category);
  const made = await createLibraryRequest(personal, author.id, undefined, targetRuleId);
  if (!made.ok) throw new Error(made.reason);
  return made.request.id;
}

const approve = async (requestId: string) => {
  const reviewer = await createUser({ email: `inputs-reviewer-${++requesters}@example.com`, role: 'admin' });
  if ('error' in reviewer) throw new Error(reviewer.error);
  const result = await approveLibraryRequest(requestId, reviewer.user.id, { enabled: true });
  if (!result.ok) throw new Error(result.reason);
};

const install = (category = 'security') => pointOn(category, '', DAY);

beforeEach(async () => {
  await resetDb();
  await clearRules();
  await execRaw('DELETE FROM posture_snapshots');
  await insertRuleRow({ id: 'r1' });
  await insertRuleRow({ id: 'r2' });
  await storeFindings([syntheticFinding('f1', [{ z: 1 }], { ruleId: 'r1', subscriptionId: SUB })]);
  await refreshSnapshotsFor(['security', 'cost'], new Date(T0));
});

afterEach(() => { vi.useRealTimers(); });

interface InputCase {
  name: string;
  /** Runs before the clock is set, for state the write needs that must not refresh a point itself. */
  setup?: () => Promise<void>;
  act: () => Promise<unknown>;
  /** What the install-wide point of the category reads after the write. */
  expected: { totalRules?: number; passingRules?: number; activeFindings?: number };
  category?: string;
}

const CASES: InputCase[] = [
  { name: 'creating a rule', act: () => createRule(newRule('r3')), expected: { totalRules: 3 } },
  { name: 'editing a rule', act: () => updateRule('r2', { name: 'Renamed' }), expected: { totalRules: 2 } },
  { name: 'disabling a rule through an edit', act: () => updateRule('r2', { enabled: false }), expected: { totalRules: 1 } },
  { name: 'moving a rule out of the category (the old one)', act: () => updateRule('r2', { category: 'cost' }), expected: { totalRules: 1 } },
  { name: 'moving a rule into a category (the new one)', act: () => updateRule('r2', { category: 'cost' }), expected: { totalRules: 1 }, category: 'cost' },
  {
    name: 'switching a rule to a version in another category (the old one)',
    setup: seedSwitchableRule, act: () => switchRuleVersion(SWITCHED, '2.0.0'), expected: { totalRules: 2 },
  },
  {
    name: 'switching a rule to a version in another category (the new one)',
    setup: seedSwitchableRule, act: () => switchRuleVersion(SWITCHED, '2.0.0'), expected: { totalRules: 1 }, category: 'cost',
  },
  { name: 'a scan syncing its findings', act: scanSecurity, expected: { totalRules: 2, activeFindings: 2 } },
  { name: 'disabling rules in bulk', act: () => setRulesEnabled(['r1', 'r2'], false), expected: { totalRules: 0 } },
  { name: 'duplicating a rule', act: () => duplicateRule('r2'), expected: { totalRules: 2 } },
  { name: 'deleting a rule', act: () => deleteRule('r1'), expected: { totalRules: 1, activeFindings: 0 } },
  { name: 'deleting a rule that has no findings', act: () => deleteRule('r2'), expected: { totalRules: 1, activeFindings: 1 } },
  { name: 'clearing a rule\'s findings', act: () => deleteFindingsForRule('r1'), expected: { totalRules: 2, activeFindings: 0, passingRules: 2 } },
  { name: 'replacing the rule set', act: () => saveRules([newRule('only')]), expected: { totalRules: 1 } },
  { name: 'approving a library request for a new rule', act: async () => approve(await openRequest('security')), expected: { totalRules: 3 } },
  {
    name: 'approving a library request that edits a rule and moves it (the old category)',
    act: async () => approve(await openRequest('cost', 'r2')), expected: { totalRules: 1 },
  },
  {
    name: 'approving a library request that edits a rule and moves it (the new category)',
    act: async () => approve(await openRequest('cost', 'r2')), expected: { totalRules: 1 }, category: 'cost',
  },
  {
    name: 'copying a Personal rule straight into the library',
    act: async () => {
      const copied = await copyPersonalRuleToLibrary((await personalRuleOf('cost')).personal);
      if (!copied.ok) throw new Error(copied.reason);
    },
    expected: { totalRules: 0 }, category: 'cost',
  },
  {
    name: 'adding a suppression',
    act: async () => addSuppression({ id: 's1', fingerprint: (await listFindings(EVERYTHING_ACCESS))[0]!.fingerprint, reason: 'test', suppressedAt: T0 }),
    expected: { activeFindings: 0, passingRules: 2 },
  },
  {
    name: 'replacing the suppressions',
    act: async () => saveSuppressions([{ id: 's1', fingerprint: (await listFindings(EVERYTHING_ACCESS))[0]!.fingerprint, reason: 'test', suppressedAt: T0 }]),
    expected: { activeFindings: 0 },
  },
  {
    name: 'a management group tree that changed',
    act: () => refreshFrom(fakeHierarchy([group('mg', 'Root', null), subscription(SUB, 'A', 'mg')])),
    expected: { totalRules: 2, activeFindings: 1 },
  },
];

describe('every posture input refreshes today\'s points', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      await c.setup?.();
      await atClock(T1, c.act);
      const point = (await install(c.category))!;
      expect(point.updatedAt).toBe(T1);
      expect(point).toMatchObject(c.expected);
    });
  }

  it('removing a suppression', async () => {
    const fingerprint = (await listFindings(EVERYTHING_ACCESS))[0]!.fingerprint;
    await atClock(T1, () => addSuppression({ id: 's1', fingerprint, reason: 'test', suppressedAt: T0 }));
    expect((await install())!.activeFindings).toBe(0);
    await atClock('2026-05-04T10:00:00.000Z', () => removeSuppression('s1'));
    expect(await install()).toMatchObject({ updatedAt: '2026-05-04T10:00:00.000Z', activeFindings: 1 });
  });

  it('a management group tree read that is identical queues nothing', async () => {
    const tree = fakeHierarchy([group('mg', 'Root', null), subscription(SUB, 'A', 'mg')]);
    await atClock(T1, () => refreshFrom(tree));
    await atClock('2026-05-04T10:00:00.000Z', () => refreshFrom(tree));
    expect((await install())!.updatedAt).toBe(T1);
    // A name alone is not a change either.
    tree.nodes = [group('mg', 'Renamed root', null), subscription(SUB, 'Renamed', 'mg')];
    await atClock('2026-05-04T11:00:00.000Z', () => refreshFrom(tree));
    expect((await install())!.updatedAt).toBe(T1);
  });

  it('a subscription moved to another group, and a group moved, each refresh', async () => {
    const tree = fakeHierarchy([group('a', 'A', null), group('b', 'B', 'a'), subscription(SUB, 'S', 'a')]);
    await atClock(T1, () => refreshFrom(tree));
    tree.nodes = [group('a', 'A', null), group('b', 'B', 'a'), subscription(SUB, 'S', 'b')];
    await atClock('2026-05-04T10:00:00.000Z', () => refreshFrom(tree));
    expect((await install())!.updatedAt).toBe('2026-05-04T10:00:00.000Z');
    // The subscription's own point is rewritten too, not only the install-wide one.
    expect((await pointOn('security', SUB, DAY))!.updatedAt).toBe('2026-05-04T10:00:00.000Z');
    tree.nodes = [group('a', 'A', null), group('b', 'B', null), subscription(SUB, 'S', 'b')];
    await atClock('2026-05-04T11:00:00.000Z', () => refreshFrom(tree));
    expect((await install())!.updatedAt).toBe('2026-05-04T11:00:00.000Z');
  });

  it('a group moved under the group a rule is scoped to rewrites the point of the subscription under it', async () => {
    // The subscription's own parent never changes: only the group above it moves.
    await insertRuleRow({ id: 'rmg', managementGroups: ['top'] });
    const tree = fakeHierarchy([group('top', 'Top', null), group('other', 'Other', null), group('b', 'B', 'other'), subscription(SUB, 'S', 'b')]);
    await atClock(T1, () => refreshFrom(tree));
    expect(await pointOn('security', SUB, DAY)).toMatchObject({ totalRules: 2, updatedAt: T1 });

    tree.nodes = [group('top', 'Top', null), group('other', 'Other', null), group('b', 'B', 'top'), subscription(SUB, 'S', 'b')];
    await atClock('2026-05-04T10:00:00.000Z', () => refreshFrom(tree));
    expect(await pointOn('security', SUB, DAY)).toMatchObject({ totalRules: 3, updatedAt: '2026-05-04T10:00:00.000Z' });
  });

  it('a failed tree read queues nothing', async () => {
    const tree = fakeHierarchy([group('mg', 'Root', null)]);
    tree.failWith = new Error('azure down');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await atClock(T1, () => refreshFrom(tree).catch(() => undefined));
    logged.mockRestore();
    expect((await install())!.updatedAt).toBe(new Date(T0).toISOString());
  });
});

describe('a suppression that expires', () => {
  const EXPIRES = '2026-05-04T08:30:00.000Z';
  const addExpiring = async () => {
    const fingerprint = (await listFindings(EVERYTHING_ACCESS))[0]!.fingerprint;
    await atClock(T0, () => addSuppression({ id: 's1', fingerprint, reason: 'test', suppressedAt: T0, expiresAt: EXPIRES }));
    expect((await install())!.activeFindings).toBe(0);
  };

  const globals = globalThis as typeof globalThis & { __rulebeatExpiryCheckedAt?: string; __rulebeatScanLock?: { busy: boolean } };
  beforeEach(() => { delete globals.__rulebeatExpiryCheckedAt; });
  afterEach(() => { globals.__rulebeatScanLock!.busy = false; });

  it('is refreshed by the first scheduler tick after it lapses', async () => {
    await addExpiring();
    await atClock('2026-05-04T08:10:00.000Z', () => refreshExpiredSuppressions(new Date('2026-05-04T08:10:00.000Z')));
    await atClock('2026-05-04T08:20:00.000Z', () => refreshExpiredSuppressions(new Date('2026-05-04T08:20:00.000Z')));
    expect((await install())!.activeFindings).toBe(0);

    await atClock('2026-05-04T08:40:00.000Z', () => refreshExpiredSuppressions(new Date('2026-05-04T08:40:00.000Z')));
    expect(await install()).toMatchObject({ activeFindings: 1, updatedAt: '2026-05-04T08:40:00.000Z' });
  });

  it('is refreshed by a tick that runs while a scan holds the busy flag', async () => {
    await addExpiring();
    await atClock('2026-05-04T08:10:00.000Z', () => refreshExpiredSuppressions(new Date('2026-05-04T08:10:00.000Z')));
    globals.__rulebeatScanLock!.busy = true;
    await atClock('2026-05-04T08:20:00.000Z', () => tickOnce({ now: new Date('2026-05-04T08:20:00.000Z') }));
    expect((await install())!.activeFindings).toBe(0);

    await atClock('2026-05-04T08:40:00.000Z', () => tickOnce({ now: new Date('2026-05-04T08:40:00.000Z') }));
    expect(await install()).toMatchObject({ activeFindings: 1, updatedAt: '2026-05-04T08:40:00.000Z' });
    // The tick held back everything else: the flag is still the scan's.
    expect(globals.__rulebeatScanLock!.busy).toBe(true);
  });

  it('is counted from the next start when it lapsed while RuleBeat was stopped', async () => {
    await addExpiring();
    await atClock('2026-05-04T09:30:00.000Z', () => backfillSnapshots());
    expect(await install()).toMatchObject({ activeFindings: 1, updatedAt: '2026-05-04T09:30:00.000Z' });
  });
});

describe('where the writer is called from', () => {
  const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    if (name === 'node_modules' || name === '.next') return [];
    return statSync(full).isDirectory() ? sourceFiles(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
  const rel = (file: string) => path.relative(WEB, file).split(path.sep).join('/');

  /** Every call of `names` in a file (or within the one top-level `statement` of it), with its arguments' text. */
  function calls(file: string, names: readonly string[], statement?: string): { name: string; args: string[] }[] {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const found: { name: string; args: string[] }[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.includes(node.expression.text)) {
        found.push({ name: node.expression.text, args: node.arguments.map(a => a.getText(source)) });
      }
      ts.forEachChild(node, visit);
    };
    if (statement === undefined) visit(source);
    else {
      for (const stmt of source.statements) {
        if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === statement) visit(stmt);
      }
    }
    return found;
  }

  it('no route or scheduler path passes `now` to the writer', () => {
    const files = [...sourceFiles(path.join(WEB, 'app')), path.join(WEB, 'lib/scheduler.ts'), path.join(WEB, 'instrumentation.ts')];
    const all = files.flatMap(f => calls(f, ['refreshSnapshotsFor', 'backfillSnapshots']).map(c => ({ ...c, file: rel(f) })));
    // The sweep found the scheduler's and the startup step's calls, so an empty list below is not an empty search.
    expect(new Set(all.map(c => c.file))).toEqual(new Set(['lib/scheduler.ts', 'instrumentation.ts']));
    expect(all.filter(c => c.args.length > (c.name === 'backfillSnapshots' ? 0 : 1))).toEqual([]);
  });

  it('only the scan runner threads a `now` to the writer, and no route sets the one it passes', () => {
    const lib = sourceFiles(path.join(WEB, 'lib')).filter(f => !rel(f).startsWith('lib/demo/'));
    const withNow = lib.filter(f => calls(f, ['refreshSnapshotsFor']).some(c => c.args.length > 1)).map(rel);
    expect(withNow).toEqual(['lib/scan-runner.ts']);
    // Every caller of the scan path outside the executor and the runner themselves (which thread the
    // option on purpose) and the Demo: the routes, and the scheduler's scheduled-scan path.
    const callers = [...sourceFiles(path.join(WEB, 'app')), ...lib, path.join(WEB, 'instrumentation.ts')]
      .filter(f => !['lib/scan-runner.ts', 'lib/run-executor.ts'].includes(rel(f)));
    const scanCalls = callers.flatMap(f => calls(f, ['runCategoryScan', 'executeTarget', 'runManualTarget']).map(c => ({ ...c, file: rel(f) })));
    expect(new Set(scanCalls.map(c => c.file))).toEqual(new Set(['app/api/scans/run/route.ts', 'lib/scheduler.ts']));
    expect(scanCalls.filter(c => c.args.some(a => /\bnow\b/.test(a)))).toEqual([]);
  });

  it('every repository writer of rules, suppressions, findings and categories refreshes, or says why it need not', () => {
    const EXEMPT: Record<string, string> = {
      setRulesLastRunStatus: 'the scan path refreshes after its own sync',
      updateCategory: 'changes the label, colour, icon and order only, which no point counts',
      createCategory: 'a new category holds no rules',
      deleteCategory: 'a deleted category writes nothing and its points leave with retention',
      syncScanFindingsDetailed: 'reports the categories it touched; the scan runner refreshes them after its commit (syncScanFindings, its thin wrapper, does not)',
      insertRuleOn: 'runs on the caller\'s transaction and reports the categories; the caller refreshes after commit',
      updateRuleOn: 'runs on the caller\'s transaction and reports the categories; the caller refreshes after commit',
      removeFindingRowsForRule: 'the half of a delete that runs on the caller\'s transaction; the caller refreshes after commit',
    };
    const unrefreshed: string[] = [];
    const writers: string[] = [];
    for (const file of ['lib/rules.ts', 'lib/suppressions.ts', 'lib/db/findings.ts', 'lib/db/categories.ts']) {
      const source = ts.createSourceFile(file, readFileSync(path.join(WEB, file), 'utf8'), ts.ScriptTarget.Latest, true);
      for (const stmt of source.statements) {
        if (!ts.isFunctionDeclaration(stmt) || !stmt.name || !stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
        const text = stmt.getText(source);
        const writes = /\.(insert|update|delete)\((rulesTable|suppressionsTable|findingsTable|categories)\b/.test(text);
        if (writes) writers.push(stmt.name.text);
        if (writes && !text.includes('refreshSnapshotsFor') && !text.includes('refreshCategoriesOf') && !EXEMPT[stmt.name.text]) unrefreshed.push(`${file}:${stmt.name.text}`);
      }
    }
    // The sweep matched the known writers, so a renamed table alias cannot leave it matching nothing.
    expect(writers).toEqual(expect.arrayContaining([
      'setRulesEnabled', 'saveRules', 'deleteRule', 'duplicateRule', 'switchRuleVersion', 'insertRuleOn', 'updateRuleOn',
      'addSuppression', 'removeSuppression', 'saveSuppressions',
      'syncScanFindingsDetailed', 'createCategory', 'updateCategory', 'deleteCategory',
    ]));
    expect(unrefreshed).toEqual([]);
  });

  it('every function that calls insertRuleOn or updateRuleOn refreshes the categories they report', () => {
    const callers: string[] = [];
    const unrefreshed: string[] = [];
    for (const file of ['lib/db/library-requests.ts', 'lib/rules.ts']) {
      const full = path.join(WEB, file);
      const source = ts.createSourceFile(full, readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true);
      for (const stmt of source.statements) {
        if (!ts.isFunctionDeclaration(stmt) || !stmt.name || stmt.name.text === 'insertRuleOn' || stmt.name.text === 'updateRuleOn') continue;
        if (calls(full, ['insertRuleOn', 'updateRuleOn'], stmt.name.text).length === 0) continue;
        callers.push(`${file}:${stmt.name.text}`);
        if (!/\brefreshSnapshotsFor\(/.test(stmt.getText(source))) unrefreshed.push(`${file}:${stmt.name.text}`);
      }
    }
    // Both approvals, the direct copy and the rule repository's own writers were found.
    expect(callers).toEqual(expect.arrayContaining([
      'lib/db/library-requests.ts:approveLibraryRequest', 'lib/db/library-requests.ts:copyPersonalRuleToLibrary',
    ]));
    expect(unrefreshed).toEqual([]);
  });

  it('the writer reads and writes only on its transaction, never on the module handle', () => {
    const text = readFileSync(path.join(WEB, 'lib/db/snapshots.ts'), 'utf8');
    const writer = text.slice(text.indexOf('async function newestEarlierPoints'), text.indexOf('async function enforceRetention'));
    expect(writer.length).toBeGreaterThan(1000);
    expect(writer).not.toMatch(/\bdb\.(select|insert|update|delete)/);
    // Its helpers that take a handle are passed the transaction.
    for (const call of ['getCategory(categoryId, tx)', 'loadRules(tx)', 'listHierarchyNodes(tx)']) expect(writer).toContain(call);
  });
});
