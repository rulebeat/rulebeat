/**
 * Every posture input writes the trend record (ADR 0012), and a new one cannot skip it.
 *
 * A posture input is a write to `findings`, to `suppressions`, or to the columns of `rules` the record keeps as facts
 * (enabled, kind, severity, scope, running version, last-run status), or a rule being inserted or deleted. Three sweeps:
 *
 *  1. Every such write in `lib/`, `app/`, `scripts/` and the root files is in `WRITERS`, each with the reason its change
 *     reaches the record, and every entry still matches a write. A writer that records says so by calling a recount in
 *     its own file; an upgrade step is recounted by the start that follows it; a planner only builds statements that an
 *     executor named here runs; a test-only function has no caller outside tests.
 *  2. `backfillFindings()` ends with a recount, since the replay it runs writes with `noRecord`.
 *  3. After the record lock is taken (`takeRecordLock()` in `lib/db/trend-record.ts`), a transaction only reads, inserts
 *     record rows and updates `trend_state` (and the coverage of the day's marker).
 *
 * Personal rule runs are named as not a posture input, and the sweep checks they stay that way.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const WEB_DIR = path.resolve(__dirname, '../..');
const read = (file: string): string => readFileSync(path.join(WEB_DIR, file), 'utf8');

// ---- The analysis ----

const WATCHED_TABLES = ['findings', 'suppressions', 'rules'] as const;
/** The `rules` columns the record keeps as facts, as the Drizzle property and as the SQL column. */
const POSTURE_RULE_COLUMNS = ['enabled', 'kind', 'severity', 'scope', 'version', 'lastRunStatus', 'last_run_status'];
const TABLE_MODULE = /(?:^|\/)(?:tables|schema|schema\.pg)$/;
/** The names a Drizzle handle goes by in this codebase: a write on anything else is not taken for a table write. */
const HANDLE = /^(?:[\w.]+\.)?(?:tx|db|handle|t|sp|savepoint|database|pgDb)$/;
const RAW_WRITE = /\b(insert\s+(?:or\s+\w+\s+)?into|update|delete\s+from)\s+(findings|suppressions|rules|\$\{[^}]*\})/gi;

export interface Write { line: number; fn: string; target: string; how: string }

function enclosingFunction(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText();
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parent) {
      if (ts.isVariableDeclaration(n.parent) || ts.isPropertyAssignment(n.parent)) return n.parent.name.getText();
    }
  }
  return '<module>';
}

/** What a rule update's `.set(...)` writes: true when it names a posture column, or when it cannot be read. */
function setsPostureColumn(update: ts.CallExpression): boolean {
  const chain = update.parent;
  if (!chain || !ts.isPropertyAccessExpression(chain) || chain.name.text !== 'set' || !ts.isCallExpression(chain.parent)) return true;
  const [arg] = chain.parent.arguments;
  if (!arg || !ts.isObjectLiteralExpression(arg)) return true;
  return arg.properties.some(p => !ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)
    ? true
    : POSTURE_RULE_COLUMNS.includes((p.name as ts.Identifier).text));
}

/** Every write to a watched table in one source file. */
export function findWrites(source: string): Write[] {
  const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  const imported = new Map<string, string>();
  let namespaceImport = false;
  for (const node of file.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || !TABLE_MODULE.test(node.moduleSpecifier.text)) continue;
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaceImport = true;
    if (bindings && ts.isNamedImports(bindings)) for (const e of bindings.elements) imported.set(e.name.text, (e.propertyName ?? e.name).text);
  }
  // `const { rules } = await import('../lib/db/tables')`, which the scripts use.
  const dynamic = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && ts.isAwaitExpression(node.initializer)) {
      const call = node.initializer.expression;
      const [module] = ts.isCallExpression(call) && call.expression.kind === ts.SyntaxKind.ImportKeyword ? call.arguments : [];
      if (module && ts.isStringLiteral(module) && TABLE_MODULE.test(module.text)) {
        for (const e of node.name.elements) if (ts.isIdentifier(e.name)) imported.set(e.name.text, (e.propertyName ?? e.name).getText(file));
      }
    }
    ts.forEachChild(node, dynamic);
  };
  dynamic(file);
  const importsWatched = namespaceImport || [...imported.values()].some(name => (WATCHED_TABLES as readonly string[]).includes(name));
  const line = (n: ts.Node) => file.getLineAndCharacterOfPosition(n.getStart(file)).line + 1;
  const writes: Write[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.arguments.length === 1
      && ['insert', 'update', 'delete'].includes(node.expression.name.text)) {
      const verb = node.expression.name.text;
      const [arg] = node.arguments;
      let table: string | undefined;
      if (ts.isIdentifier(arg!)) {
        const name = imported.get(arg.text);
        if (name !== undefined) table = (WATCHED_TABLES as readonly string[]).includes(name) ? name : undefined;
        else if (importsWatched && HANDLE.test(node.expression.expression.getText(file))) table = 'a table this file does not name';
      } else if (ts.isPropertyAccessExpression(arg!)) {
        table = (WATCHED_TABLES as readonly string[]).includes(arg.name.text) ? arg.name.text : undefined;
      }
      if (table !== undefined && (table !== 'rules' || verb !== 'update' || setsPostureColumn(node))) {
        writes.push({ line: line(node), fn: enclosingFunction(node), target: table, how: verb });
      }
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const text = ts.isTemplateExpression(node) ? node.getText(file) : node.text;
      for (const m of text.matchAll(RAW_WRITE)) {
        const target = m[2]!.toLowerCase();
        const statement = text.slice(m.index!, text.length);
        const verb = m[1]!.toLowerCase().split(/\s+/)[0]!;
        const touchesPosture = new RegExp(`\\b(${POSTURE_RULE_COLUMNS.filter(c => /^[a-z_]+$/.test(c)).join('|')})\\b`, 'i').test(statement.split(/\bwhere\b/i)[0]!);
        if (target === 'rules' && verb === 'update' && !touchesPosture) continue;
        writes.push({ line: line(node), fn: enclosingFunction(node), target, how: `sql ${verb}` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return writes;
}

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) found.push(full);
  }
  return found;
}
const rel = (file: string): string => path.relative(WEB_DIR, file).split(path.sep).join('/');

const SCANNED = [
  ...['lib', 'app', 'scripts', 'components'].flatMap(d => sourceFiles(path.join(WEB_DIR, d))),
  ...readdirSync(WEB_DIR).filter(f => /\.tsx?$/.test(f)).map(f => path.join(WEB_DIR, f)),
].map(f => ({ file: rel(f), source: readFileSync(f, 'utf8') }));

const RECOUNT_CALL = /\b(?:recountTrend|recountTrendSqlite|recountTrendPg|startTrendRecording|startTrendRecordingPg)\(/;

// ---- The allowlist ----

type Kind =
  /** The file records its own writes: it calls a recount, in the transaction of the change. */
  | 'records'
  /** The trend-record module itself; what it may write after the lock is the last block of this file. */
  | 'record'
  /** Replaces or shifts the record together with the data it counts. */
  | 'replaces'
  /** An upgrade or seed step; the start that follows every one of them recounts every key. */
  | 'upgrade'
  /** Only builds statements; the executors named run them and recount. */
  | 'plan'
  /** Nothing outside tests calls it. */
  | 'test-only'
  /** A benchmark or demo script that builds a database of its own. */
  | 'tooling';

interface Writer { file: string; fn?: string; kind: Kind; reason: string; executors?: { file: string; uses: string }[] }

const WRITERS: Writer[] = [
  { file: 'lib/db/trend-record.ts', kind: 'record', reason: 'the one module that writes the record: cell and fact rows, the Recorded day marker and trend_state' },
  { file: 'lib/db/findings.ts', kind: 'records', reason: 'the scan sync, a rule\'s cleared findings and the history backfill each recount their rules in their own transaction' },
  { file: 'lib/suppressions.ts', fn: 'saveSuppressions', kind: 'test-only', reason: 'replaces the whole set for test fixtures; no route or job calls it' },
  { file: 'lib/suppressions.ts', kind: 'records', reason: 'add and remove recount the rules of the finding they suppress in the same transaction' },
  { file: 'lib/rules.ts', fn: 'saveRules', kind: 'test-only', reason: 'deletes and reinserts every rule for test fixtures; no route or job calls it' },
  { file: 'lib/rules.ts', kind: 'records', reason: 'every rule write recounts the rules it changed in the same transaction' },
  { file: 'lib/workspace-placement.ts', kind: 'records', reason: 'moves Logs findings to their workspace and recounts their rules in the same transaction' },
  { file: 'lib/db/migrate.ts', kind: 'upgrade', reason: 'SQLite upgrade and seed steps: the placement and rekey steps recount their own change, and every start recounts every key (startTrendRecording)' },
  { file: 'lib/db/pg/seeds.ts', kind: 'upgrade', reason: 'Postgres seed steps: rule seeding recounts what it touched, and every start recounts every key (startTrendRecordingPg)' },
  { file: 'lib/db/pg/bootstrap.ts', kind: 'upgrade', reason: 'Postgres bootstrap steps: the placement and rekey steps recount their own change, and the start that follows recounts every key' },
  {
    file: 'lib/db/fingerprint-rekey.ts', kind: 'plan', reason: 'builds the rekey statements; its executors recount in the transaction that runs them',
    executors: [{ file: 'lib/db/migrate.ts', uses: 'planFingerprintRekey' }, { file: 'lib/db/pg/bootstrap.ts', uses: 'planFingerprintRekey' }],
  },
  {
    file: 'lib/db/finding-placement.ts', kind: 'plan', reason: 'builds the placement statements; its executors recount in the transaction that runs them',
    executors: [{ file: 'lib/db/migrate.ts', uses: 'planFindingPlacement' }, { file: 'lib/db/pg/bootstrap.ts', uses: 'planFindingPlacement' }],
  },
  { file: 'lib/demo/reset.ts', kind: 'replaces', reason: 'the Demo Reset replaces every table, the record included, from one snapshot and shifts every date by the same gap, so the record and the data it counts move as one' },
  { file: 'scripts/bench/finding-views.ts', kind: 'tooling', reason: 'builds the benchmark database it measures; it is not an install and has no trend record to keep' },
];

/** Files that run rules or findings without being a posture input, each with why. The sweep keeps them clean. */
const NOT_POSTURE_INPUTS: { file: string; reason: string }[] = [
  { file: 'lib/personal-rule-run.ts', reason: 'a Personal rule run never goes through a scan, a finding sync or the findings table; its results are one person\'s and are not findings' },
  { file: 'lib/db/personal-rules.ts', reason: 'Personal rules and their results live in their own tables and are not counted by any cell' },
];

const matches = (w: Writer, file: string, write: Write): boolean => w.file === file && (w.fn === undefined || w.fn === write.fn);

describe('the writer sweep', () => {
  it('finds the writers it should and the writes they make', () => {
    expect(SCANNED.length).toBeGreaterThan(300);
    const found = Object.fromEntries(SCANNED.map(f => [f.file, findWrites(f.source)]));
    expect(found['lib/db/findings.ts']!.map(w => w.how)).toEqual(expect.arrayContaining(['insert', 'update', 'delete']));
    expect(found['lib/suppressions.ts']!.map(w => w.fn)).toEqual(expect.arrayContaining(['addSuppression', 'removeSuppression', 'saveSuppressions']));
    expect(found['lib/rules.ts']!.map(w => w.fn)).toEqual(expect.arrayContaining(['saveRules', 'insertRuleOn', 'updateRuleOn', 'updateEnabled', 'deleteRule']));
    expect(found['lib/workspace-placement.ts']!.length).toBeGreaterThan(0);
    expect(found['lib/db/migrate.ts']!.length).toBeGreaterThan(10);
  });

  it('every write to findings, suppressions or the rules\' posture columns is by a listed writer', () => {
    const unlisted = SCANNED.flatMap(({ file, source }) => findWrites(source)
      .filter(w => !WRITERS.some(entry => matches(entry, file, w)))
      .map(w => `${file}:${w.line} ${w.fn}() writes ${w.target} (${w.how})`));
    expect(unlisted, 'write through lib/db/trend-record.ts in the same transaction, then list the writer in WRITERS').toEqual([]);
  });

  it('every listed writer still writes, and says why', () => {
    for (const w of WRITERS) {
      const entry = SCANNED.find(f => f.file === w.file);
      expect(entry, `${w.file} exists`).toBeDefined();
      expect(findWrites(entry!.source).some(write => matches(w, w.file, write)), `${w.file}${w.fn ? `:${w.fn}` : ''} still writes`).toBe(true);
      expect(w.reason.length, `${w.file} has a reason`).toBeGreaterThan(20);
    }
  });

  it('a writer that records calls a recount, an upgrade step is followed by the start, and a planner has executors that recount', () => {
    for (const w of WRITERS) {
      const source = SCANNED.find(f => f.file === w.file)!.source;
      if (w.kind === 'records') expect(RECOUNT_CALL.test(source), `${w.file} calls a recount`).toBe(true);
      if (w.kind === 'record') expect(writesAfterTheLock(source), `${w.file} writes only the record`).toEqual([]);
      if (w.kind === 'replaces') expect(source, `${w.file} skips no trend table`).toContain("const SKIPPED_TABLES = new Set(['meta'])");
      if (w.kind === 'upgrade') expect(/\b(?:startTrendRecording|startTrendRecordingPg)\(|\brecountTrend(?:Sqlite|Pg)\(/.test(source), `${w.file} starts or recounts the record`).toBe(true);
      if (w.kind === 'plan') {
        expect(w.executors?.length, `${w.file} names its executors`).toBeGreaterThan(0);
        for (const e of w.executors!) {
          const executor = SCANNED.find(f => f.file === e.file)!.source;
          expect(executor.includes(e.uses), `${e.file} runs ${e.uses}`).toBe(true);
          expect(RECOUNT_CALL.test(executor), `${e.file} recounts`).toBe(true);
        }
      }
    }
  });

  it('a test-only function is called by nothing outside tests', () => {
    for (const w of WRITERS.filter(x => x.kind === 'test-only')) {
      const callers = SCANNED.flatMap(({ file, source }) => {
        const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
        let count = 0;
        const visit = (n: ts.Node): void => {
          if (ts.isIdentifier(n) && n.text === w.fn && !(ts.isFunctionDeclaration(n.parent) && n.parent.name === n)) count++;
          ts.forEachChild(n, visit);
        };
        visit(sf);
        return count > 0 ? [file] : [];
      });
      expect(callers, `${w.fn} has a caller outside tests`).toEqual([]);
    }
  });

  it('the findings backfill ends with a recount of what it replayed', () => {
    const sf = ts.createSourceFile('findings.ts', read('lib/db/findings.ts'), ts.ScriptTarget.Latest, true);
    let backfill: ts.FunctionDeclaration | undefined;
    sf.forEachChild(n => { if (ts.isFunctionDeclaration(n) && n.name?.text === 'backfillFindings') backfill = n; });
    expect(backfill, 'backfillFindings exists').toBeDefined();
    const calls: { name: string; end: number }[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) calls.push({ name: n.expression.text, end: n.getEnd() });
      ts.forEachChild(n, visit);
    };
    visit(backfill!);
    const lastReplay = Math.max(...calls.filter(c => c.name === 'syncScanFindings').map(c => c.end));
    const lastRecount = Math.max(...calls.filter(c => c.name === 'recountTrend').map(c => c.end));
    expect(lastReplay, 'backfillFindings replays syncScanFindings').toBeGreaterThan(0);
    expect(lastRecount, 'backfillFindings recounts after its last replay').toBeGreaterThan(lastReplay);
  });

  it('a Personal rule run is not a posture input: it writes none of what the record counts and never reaches the record', () => {
    for (const { file, reason } of NOT_POSTURE_INPUTS) {
      const entry = SCANNED.find(f => f.file === file);
      expect(entry, `${file} exists`).toBeDefined();
      expect(findWrites(entry!.source), `${file} writes a posture input`).toEqual([]);
      expect(/syncScanFindings|trend-record/.test(entry!.source), `${file} reaches the record`).toBe(false);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});

describe('the analysis', () => {
  const write = (source: string) => findWrites(`import { findings, suppressions, rules, personalRules } from './tables';\n${source}`);

  it('sees a findings write through its import name or an alias', () => {
    expect(write('async function a(tx) { await run(tx.update(findings).set({ status: "fixed" })); }')).toMatchObject([{ fn: 'a', target: 'findings', how: 'update' }]);
    expect(findWrites("import { findings as f } from '../tables';\nfunction b(db) { db.delete(f); }")).toMatchObject([{ fn: 'b', target: 'findings', how: 'delete' }]);
  });

  it('sees a write to a table imported on the spot', () => {
    expect(findWrites("async function l(tx) { const { suppressions: s } = await import('../lib/db/tables'); tx.delete(s); }")).toMatchObject([{ fn: 'l', target: 'suppressions' }]);
  });

  it('sees a write to a table it cannot name when the file imports a watched table', () => {
    expect(write('function c(tx, t) { tx.update(t).set({}); }')).toMatchObject([{ fn: 'c', target: 'a table this file does not name' }]);
  });

  it('sees a raw SQL write', () => {
    expect(findWrites('const s = `DELETE FROM findings WHERE rule_id = ?`;')).toMatchObject([{ target: 'findings', how: 'sql delete' }]);
    expect(findWrites("const s = 'INSERT OR IGNORE INTO suppressions (id) VALUES (?)';")).toMatchObject([{ target: 'suppressions', how: 'sql insert' }]);
    expect(findWrites('const s = `UPDATE ${table} SET placement = ?`;')).toMatchObject([{ how: 'sql update' }]);
  });

  it('counts a rule update only when it sets a posture column', () => {
    expect(write('function d(tx) { tx.update(rules).set({ enabled: true }); }')).toHaveLength(1);
    expect(write('function e(tx) { tx.update(rules).set({ lastRunStatus: "success" }); }')).toHaveLength(1);
    expect(write('function f(tx, set) { tx.update(rules).set(set); }')).toHaveLength(1);
    expect(write('function g(tx) { tx.update(rules).set({ name: "x" }); }')).toEqual([]);
    expect(write('function h(tx) { tx.insert(rules).values({}); tx.delete(rules); }')).toHaveLength(2);
    expect(findWrites("const s = 'UPDATE rules SET type = ? WHERE id = ?';")).toEqual([]);
    expect(findWrites("const s = 'UPDATE rules SET severity = ? WHERE id = ?';")).toHaveLength(1);
  });

  it('leaves reads, other tables and plain map deletes alone', () => {
    expect(write('function i(tx) { return tx.select().from(findings); }')).toEqual([]);
    expect(write('function j(tx) { tx.update(personalRules).set({}); tx.insert(personalRules); }')).toEqual([]);
    expect(write('function k(seen) { seen.delete(key); }')).toEqual([]);
  });

  it('names the nearest named function, skipping callbacks', () => {
    expect(write('async function outer(tx) { await inTransaction(async (handle) => { handle.delete(suppressions); }); }')).toMatchObject([{ fn: 'outer' }]);
    expect(write('export const arrow = async (tx) => { tx.delete(findings); };')).toMatchObject([{ fn: 'arrow' }]);
    expect(write('tx.delete(findings);')).toMatchObject([{ fn: '<module>' }]);
  });
});

// ---- After the record lock ----

/** What `lib/db/trend-record.ts` may write at all, which is everything it may write once the lock is taken. */
const RECORD_INSERTS = ['trendCells', 'trendRuleFacts', 'trendRecordedDays', 'trendState'];
const RECORD_UPDATES = ['trendState', 'trendRecordedDays'];

/** The writes in a source that a transaction holding the record lock may not make. */
export function writesAfterTheLock(source: string): string[] {
  const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  const problems: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const verb = n.expression.name.text;
      const arg = n.arguments[0];
      const table = arg && (ts.isPropertyAccessExpression(arg) ? arg.name.text : ts.isIdentifier(arg) ? arg.text : arg.getText(sf));
      const at = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      if (verb === 'insert' && n.arguments.length === 1 && !RECORD_INSERTS.includes(table!)) problems.push(`line ${at}: inserts into ${table}`);
      if (verb === 'update' && n.arguments.length === 1 && !RECORD_UPDATES.includes(table!)) problems.push(`line ${at}: updates ${table}`);
      // A delete is any delete on a database handle; `seen.delete(key)` on a Map is not one.
      if (verb === 'delete' && n.arguments.length === 1 && HANDLE.test(n.expression.expression.getText(sf))) problems.push(`line ${at}: deletes from ${table}`);
    }
    if (ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) {
      const text = ts.isTemplateExpression(n) ? n.getText(sf) : n.text;
      if (/\b(?:insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i.test(text)) problems.push(`line ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: raw SQL write`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return problems;
}

describe('after the record lock', () => {
  it('trend-record.ts only reads, inserts record rows and updates trend_state and the day marker\'s coverage', () => {
    const source = read('lib/db/trend-record.ts');
    expect(source).toContain('takeRecordLock');
    expect(writesAfterTheLock(source)).toEqual([]);
  });

  it('spots an insert, an update, a delete and a raw write to any other table', () => {
    expect(writesAfterTheLock('function* s(c) { yield* run(c.tx.insert(c.t.findings).values({})); }')).toHaveLength(1);
    expect(writesAfterTheLock('function* s(c) { yield* run(c.tx.update(c.t.rules).set({})); }')).toHaveLength(1);
    expect(writesAfterTheLock('function* s(c) { yield* run(c.tx.delete(c.t.trendCells)); }')).toHaveLength(1);
    expect(writesAfterTheLock('const q = `UPDATE rules SET enabled = 1`;')).toHaveLength(1);
  });

  it('lets the record\'s own writes through', () => {
    expect(writesAfterTheLock('function* s(c) { yield* run(c.tx.insert(c.t.trendCells).values({})); yield* run(tx.update(trendState).set({})); seen.delete(key); }')).toEqual([]);
  });
});
