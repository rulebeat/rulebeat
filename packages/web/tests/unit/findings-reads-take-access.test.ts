/**
 * #270: every read of findings, or of data derived from them, takes the caller's `Access`.
 *
 * Two sweeps over `lib/`:
 *
 *  1. In every findings-family module, an exported function has a required `access: Access` parameter (no
 *     `?`, no default, placed after the required parameters and before any optional one), or is named in
 *     `EXEMPT` with a one-line reason: a write, a pure helper, or a helper that runs on the caller's
 *     transaction handle over fingerprints the caller already read.
 *  2. A `lib/` or `app/` file outside the family does not import a findings-family table, unless it is in
 *     `TABLE_IMPORT_EXEMPT` (a SQL-fragment builder, the connection and the schema bootstrap), so a read
 *     cannot go around the family's functions.
 *
 * This test only keeps the parameter from being dropped; access-matrix.test.ts checks what it narrows.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const WEB_DIR = path.resolve(__dirname, '../..');

const FAMILY = [
  'lib/db/findings.ts',
  'lib/db/finding-views.ts',
  'lib/db/scan-snapshots.ts',
  'lib/db/scan-compare.ts',
  'lib/db/snapshots.ts',
  'lib/db/scan-blob-history.ts',
  'lib/db/column-catalogue.ts',
  'lib/scan-history.ts',
  'lib/schedule-runs.ts',
  'lib/suppressions.ts',
  'lib/dashboard-data.ts',
  'lib/advisories-widget-data.ts',
  'lib/explorer-data.ts',
  'lib/workspace-placement.ts',
];

/** Exported functions that do not take an access, each with the reason. */
const EXEMPT: Record<string, Record<string, string>> = {
  'lib/db/findings.ts': {
    rowToRecordFromColumns: 'pure helper over a row already read',
    rowToSummary: 'pure helper over a row already read',
    rowsTableReady: 'runs on the caller\'s transaction handle, reads no findings',
    loadFindingRows: 'runs on the caller\'s transaction handle over fingerprints the caller already read',
    loadFindingRowsRange: 'runs on the caller\'s transaction handle over fingerprints the caller already read',
    syncScanFindings: 'write: stores a scan\'s findings',
    syncScanFindingsDetailed: 'write: stores a scan\'s findings',
    deleteFindingsForRule: 'write: removes a deleted rule\'s findings',
    removeFindingRowsForRule: 'write: removes a rule\'s finding rows',
    refreshSnapshotsFor: 'write: recomputes the stored snapshots, under the system access',
    backfillFindings: 'write: startup backfill, under the system access',
  },
  'lib/db/finding-views.ts': {
    planExportReads: 'pure planner over a count already read',
  },
  'lib/db/scan-snapshots.ts': {
    escapeLike: 'pure helper',
    toRecord: 'pure helper over a row already read',
    readHeader: 'runs on the caller\'s read handle over a scan the caller already resolved',
    readExisting: 'runs on the caller\'s read handle over a scan the caller already resolved',
    readExportBatches: 'streams the batches of an export the caller already opened with its access',
  },
  'lib/db/snapshots.ts': {
    upsertDailySnapshot: 'write: stores an install-wide value, so it is computed under the system access',
    getLastSnapshotTimes: 'returns only a time, which is the same for everyone and holds no count',
    backfillSnapshots: 'write: startup backfill, under the system access',
  },
  'lib/db/column-catalogue.ts': {
    listReturnedColumnsIn: 'runs on the caller\'s transaction handle',
    rebuildColumnCatalogue: 'write: rebuilds the catalogue',
    removeColumnCatalogueForRule: 'write: removes a rule\'s catalogue',
  },
  'lib/scan-history.ts': {
    saveScanResult: 'write: stores a scan',
  },
  'lib/schedule-runs.ts': {
    staleBefore: 'pure helper over a clock',
    startRun: 'write: opens a run',
    finishRun: 'write: closes a run',
    markNotifySent: 'write: run bookkeeping',
    claimNotifyDispatch: 'write: run bookkeeping',
    heartbeatRun: 'write: run bookkeeping',
    recordCategoryProgress: 'write: run bookkeeping',
  },
  'lib/suppressions.ts': {
    addSuppression: 'write: stores a suppression',
    removeSuppression: 'write: removes a suppression',
    saveSuppressions: 'write: replaces the suppressions',
    isActiveSuppression: 'pure helper over a suppression already read',
  },
  'lib/workspace-placement.ts': {
    placeWorkspaceFindings: 'write: places stored findings, under the system access',
  },
};

/** Files outside the family that import a findings-family table, each with the reason. */
const TABLE_IMPORT_EXEMPT: Record<string, string> = {
  'lib/db/finding-kinds-sql.ts': 'SQL-fragment builder: returns a predicate, reads nothing',
  'lib/db/subscription-filter.ts': 'SQL-fragment builder: returns a predicate, reads nothing',
  'lib/db/access-filter.ts': 'SQL-fragment builder: returns the predicate an access puts on findings, reads nothing',
  'lib/db/client.ts': 'opens the connection with the whole schema',
  'lib/db/tables.ts': 'picks the table set for the backend',
  'lib/db/snapshot.ts': 'opens a read-only connection of its own with the whole schema, for an export',
  'lib/db/pg/bootstrap.ts': 'creates the Postgres schema',
  'lib/db/pg/seeds.ts': 'seeds the Postgres schema',
};

const FAMILY_TABLES = [
  'findings', 'findingRows', 'findingEvents', 'scanFindings', 'postureSnapshots',
  'suppressions', 'scans', 'scheduleRuns', 'columnCatalogue',
];

export interface ParamInfo { name: string; type: string; optional: boolean }
export interface FunctionInfo { name: string; params: ParamInfo[] }

/** The exported functions of a source file: declarations, and consts holding an arrow or function. */
export function exportedFunctions(source: string): FunctionInfo[] {
  const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  const isExported = (n: ts.Node): boolean =>
    ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword);
  const paramsOf = (fn: ts.SignatureDeclaration): ParamInfo[] => fn.parameters.map(p => ({
    name: p.name.getText(file),
    type: p.type?.getText(file) ?? '',
    optional: Boolean(p.questionToken || p.initializer || p.dotDotDotToken),
  }));
  const found: FunctionInfo[] = [];
  for (const node of file.statements) {
    if (ts.isFunctionDeclaration(node) && node.name && isExported(node)) {
      found.push({ name: node.name.text, params: paramsOf(node) });
    } else if (ts.isVariableStatement(node) && isExported(node)) {
      for (const d of node.declarationList.declarations) {
        const init = d.initializer;
        if (ts.isIdentifier(d.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          found.push({ name: d.name.text, params: paramsOf(init) });
        }
      }
    }
  }
  return found;
}

/** Why a function does not take the access the way the convention says, or null when it does. */
export function accessProblem(fn: FunctionInfo): string | null {
  const at = fn.params.findIndex(p => p.name === 'access');
  if (at < 0) return 'has no access parameter';
  const p = fn.params[at]!;
  if (p.type !== 'Access') return `access is typed '${p.type}', not Access`;
  if (p.optional) return 'access is optional or has a default';
  if (fn.params.slice(0, at).some(q => q.optional)) return 'access comes after an optional parameter';
  return null;
}

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

const rel = (file: string): string => path.relative(WEB_DIR, file).split(path.sep).join('/');

/** Whether a file imports a findings-family table (or the whole schema, which holds them) from the table modules. */
export function importsFamilyTable(source: string): boolean {
  const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  for (const node of file.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    if (!/(?:^|\/)(?:tables|schema|schema\.pg)$/.test(node.moduleSpecifier.text)) continue;
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) return true;
    if (bindings && ts.isNamedImports(bindings)) {
      if (bindings.elements.some(e => FAMILY_TABLES.includes((e.propertyName ?? e.name).text))) return true;
    }
  }
  return false;
}

describe('a family function takes a required access', () => {
  const fn = (params: string) => exportedFunctions(`export async function f(${params}) {}`)[0]!;

  it('accepts a required access after the required parameters and before the optional ones', () => {
    expect(accessProblem(fn('access: Access'))).toBeNull();
    expect(accessProblem(fn('view: View, query: Q, access: Access'))).toBeNull();
    expect(accessProblem(fn('access: Access, opts = {}'))).toBeNull();
    expect(accessProblem(fn('module: string, access: Access, limit = 20'))).toBeNull();
  });

  it('rejects an optional access, a defaulted access, a missing one, a loosely typed one and one after an optional', () => {
    expect(accessProblem(fn('access?: Access'))).not.toBeNull();
    expect(accessProblem(fn('access: Access = x'))).not.toBeNull();
    expect(accessProblem(fn('view: View'))).not.toBeNull();
    expect(accessProblem(fn('access: unknown'))).not.toBeNull();
    expect(accessProblem(fn('limit = 20, access: Access'))).not.toBeNull();
  });

  it('reads declarations and arrow constants, and leaves types, classes and plain constants alone', () => {
    const found = exportedFunctions([
      'export function a(access: Access) {}',
      'export const b = (x: string) => x;',
      'export const c = 5;',
      'export class D {}',
      'export type E = string;',
      'function notExported(x: string) {}',
    ].join('\n'));
    expect(found.map(f => f.name)).toEqual(['a', 'b']);
  });
});

describe('every exported function of the findings family takes access or says why not', () => {
  it('sweeps all of the family files and finds the reads', () => {
    expect(FAMILY.length).toBeGreaterThanOrEqual(14);
    const all = FAMILY.flatMap(f => exportedFunctions(readFileSync(path.join(WEB_DIR, f), 'utf8')).map(fn => `${f}:${fn.name}`));
    expect(all.length).toBeGreaterThan(60);
    for (const known of ['lib/db/findings.ts:listFindings', 'lib/db/finding-views.ts:queryView', 'lib/schedule-runs.ts:listRuns', 'lib/dashboard-data.ts:computeWidgetSummary']) {
      expect(all, known).toContain(known);
    }
  });

  for (const file of FAMILY) {
    it(`${file}`, () => {
      const exempt = EXEMPT[file] ?? {};
      const functions = exportedFunctions(readFileSync(path.join(WEB_DIR, file), 'utf8'));
      const problems = functions
        .filter(f => !(f.name in exempt))
        .map(f => ({ f, problem: accessProblem(f) }))
        .filter(x => x.problem)
        .map(x => `${x.f.name}: ${x.problem}`);
      expect(problems).toEqual([]);

      // An exemption has to stay true: the function is still exported and still does not take an access.
      for (const name of Object.keys(exempt)) {
        const found = functions.find(f => f.name === name);
        expect(found, `${file} still exports ${name}`).toBeDefined();
        expect(accessProblem(found!), `${name} no longer needs its exemption`).not.toBeNull();
        expect(exempt[name]!.length, `${name} has a reason`).toBeGreaterThan(5);
      }
    });
  }

  it('lists no exemption for a file outside the family', () => {
    expect(Object.keys(EXEMPT).filter(f => !FAMILY.includes(f))).toEqual([]);
  });
});

describe('no file outside the family imports a findings-family table', () => {
  it('spots a table import, a namespace import and a lookalike on fixture strings', () => {
    expect(importsFamilyTable("import { findings as findingsTable } from './tables';")).toBe(true);
    expect(importsFamilyTable("import { scans } from './db/tables';")).toBe(true);
    expect(importsFamilyTable("import { scheduleRuns } from '@/lib/db/tables';")).toBe(true);
    expect(importsFamilyTable("import * as schema from './schema';")).toBe(true);
    expect(importsFamilyTable("import type * as pgSchema from '../schema.pg';")).toBe(true);
    expect(importsFamilyTable("import { rules, categories } from './tables';")).toBe(false);
    expect(importsFamilyTable("import { findings } from './finding-store';")).toBe(false);
  });

  const files = [
    ...sourceFiles(path.join(WEB_DIR, 'lib')),
    ...sourceFiles(path.join(WEB_DIR, 'app')),
  ].map(f => ({ file: rel(f), source: readFileSync(f, 'utf8') }));

  it('sweeps the files and finds the family importing its tables', () => {
    expect(files.length).toBeGreaterThan(100);
    const importers = files.filter(f => importsFamilyTable(f.source)).map(f => f.file);
    for (const known of ['lib/db/findings.ts', 'lib/suppressions.ts', 'lib/schedule-runs.ts', 'lib/db/snapshots.ts']) {
      expect(importers, known).toContain(known);
    }
  });

  it('holds outside the family and the written exemptions', () => {
    const outside = files
      .filter(f => !FAMILY.includes(f.file) && !(f.file in TABLE_IMPORT_EXEMPT))
      .filter(f => importsFamilyTable(f.source))
      .map(f => f.file);
    expect(outside).toEqual([]);
  });

  it('keeps each exemption true: the file is there, still imports a table, and says why', () => {
    for (const [file, reason] of Object.entries(TABLE_IMPORT_EXEMPT)) {
      const entry = files.find(f => f.file === file);
      expect(entry, `${file} exists`).toBeDefined();
      expect(importsFamilyTable(entry!.source), `${file} still imports a table`).toBe(true);
      expect(reason.length, file).toBeGreaterThan(10);
    }
  });
});
