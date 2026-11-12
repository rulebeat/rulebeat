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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshSnapshotsFor, backfillSnapshots } from '@/lib/db/snapshots';
import { listFindings, deleteFindingsForRule } from '@/lib/db/findings';
import { createRule, deleteRule, duplicateRule, saveRules, setRulesEnabled, updateRule } from '@/lib/rules';
import { addSuppression, removeSuppression, saveSuppressions } from '@/lib/suppressions';
import { refreshExpiredSuppressions } from '@/lib/scheduler';
import { clearRules, execRaw, resetDb } from '../helpers/db';
import { EVERYTHING_ACCESS } from '../helpers/access';
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

const newRule = (id: string, over: Partial<Rule> = {}): Rule => ({
  id, name: `New rule ${id}`, description: 'a rule', category: 'security', severity: 'medium', enabled: true, type: 'custom',
  scope: { level: 'subscription' }, resourceTypes: [], conditions: [], rawKql: 'resources | project id', ...over,
} as unknown as Rule);

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
  { name: 'disabling rules in bulk', act: () => setRulesEnabled(['r1', 'r2'], false), expected: { totalRules: 0 } },
  { name: 'duplicating a rule', act: () => duplicateRule('r2'), expected: { totalRules: 2 } },
  { name: 'deleting a rule', act: () => deleteRule('r1'), expected: { totalRules: 1, activeFindings: 0 } },
  { name: 'deleting a rule that has no findings', act: () => deleteRule('r2'), expected: { totalRules: 1, activeFindings: 1 } },
  { name: 'clearing a rule\'s findings', act: () => deleteFindingsForRule('r1'), expected: { totalRules: 2, activeFindings: 0, passingRules: 2 } },
  { name: 'replacing the rule set', act: () => saveRules([newRule('only')]), expected: { totalRules: 1 } },
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
    tree.nodes = [group('a', 'A', null), group('b', 'B', null), subscription(SUB, 'S', 'b')];
    await atClock('2026-05-04T11:00:00.000Z', () => refreshFrom(tree));
    expect((await install())!.updatedAt).toBe('2026-05-04T11:00:00.000Z');
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

  it('is refreshed by the first scheduler tick after it lapses, busy or not', async () => {
    await addExpiring();
    await atClock('2026-05-04T08:10:00.000Z', () => refreshExpiredSuppressions(new Date('2026-05-04T08:10:00.000Z')));
    await atClock('2026-05-04T08:20:00.000Z', () => refreshExpiredSuppressions(new Date('2026-05-04T08:20:00.000Z')));
    expect((await install())!.activeFindings).toBe(0);

    await atClock('2026-05-04T08:40:00.000Z', () => refreshExpiredSuppressions(new Date('2026-05-04T08:40:00.000Z')));
    expect(await install()).toMatchObject({ activeFindings: 1, updatedAt: '2026-05-04T08:40:00.000Z' });
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

  /** Every call of `names` in a file, with its arguments' text. */
  function calls(file: string, names: readonly string[]): { name: string; args: string[] }[] {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const found: { name: string; args: string[] }[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.includes(node.expression.text)) {
        found.push({ name: node.expression.text, args: node.arguments.map(a => a.getText(source)) });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  }

  it('no route or scheduler path passes `now` to the writer', () => {
    const files = [...sourceFiles(path.join(WEB, 'app')), path.join(WEB, 'lib/scheduler.ts'), path.join(WEB, 'instrumentation.ts')];
    const passing = files.flatMap(f => calls(f, ['refreshSnapshotsFor', 'backfillSnapshots']).filter(c => c.args.length > (c.name === 'backfillSnapshots' ? 0 : 1)).map(() => rel(f)));
    expect(passing).toEqual([]);
  });

  it('only the scan runner threads a `now` to the writer, and no route sets the one it passes', () => {
    const lib = sourceFiles(path.join(WEB, 'lib')).filter(f => !rel(f).startsWith('lib/demo/'));
    const withNow = lib.filter(f => calls(f, ['refreshSnapshotsFor']).some(c => c.args.length > 1)).map(rel);
    expect(withNow).toEqual(['lib/scan-runner.ts']);
    const routesSettingIt = sourceFiles(path.join(WEB, 'app'))
      .filter(f => calls(f, ['runCategoryScan', 'executeTarget', 'runManualTarget']).some(c => c.args.some(a => /\bnow\b/.test(a))))
      .map(rel);
    expect(routesSettingIt).toEqual([]);
  });

  it('every repository writer of rules and suppressions refreshes, or says why it need not', () => {
    const EXEMPT: Record<string, string> = {
      setRulesLastRunStatus: 'the scan path refreshes after its own sync',
      insertRuleOn: 'runs on the caller\'s transaction and reports the categories; the caller refreshes after commit',
      updateRuleOn: 'runs on the caller\'s transaction and reports the categories; the caller refreshes after commit',
      removeFindingRowsForRule: 'the half of a delete that runs on the caller\'s transaction; the caller refreshes after commit',
    };
    const unrefreshed: string[] = [];
    for (const file of ['lib/rules.ts', 'lib/suppressions.ts']) {
      const source = ts.createSourceFile(file, readFileSync(path.join(WEB, file), 'utf8'), ts.ScriptTarget.Latest, true);
      for (const stmt of source.statements) {
        if (!ts.isFunctionDeclaration(stmt) || !stmt.name || !stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
        const text = stmt.getText(source);
        const writes = /\.(insert|update|delete)\((rulesTable|suppressionsTable)\b/.test(text);
        if (writes && !text.includes('refreshSnapshotsFor') && !text.includes('refreshCategoriesOf') && !EXEMPT[stmt.name.text]) unrefreshed.push(`${file}:${stmt.name.text}`);
      }
    }
    expect(unrefreshed).toEqual([]);
  });

  it('every caller of insertRuleOn and updateRuleOn refreshes the categories they report', () => {
    for (const file of ['lib/db/library-requests.ts', 'lib/rules.ts']) {
      const source = readFileSync(path.join(WEB, file), 'utf8');
      if (/\b(insertRuleOn|updateRuleOn)\(/.test(source.replace(/export async function (insertRuleOn|updateRuleOn)/g, ''))) {
        expect(source, file).toContain('refreshSnapshotsFor');
      }
    }
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
