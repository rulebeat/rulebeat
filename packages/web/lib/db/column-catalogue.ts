import { and, eq, inArray } from 'drizzle-orm';
import { db } from './client';
import { columnCatalogue as catalogueTable, findings as findingsTable, findingRows as findingRowsTable, meta as metaTable } from './tables';
import { many, one, run, type DbHandle } from './exec';
import { chunk } from './chunk';
import { COLUMN_CATALOGUE_MARKER, PathCollector } from './column-catalogue-build';

/**
 * The per-rule column catalogue (ADR 0007): which columns a rule's findings returned, kept beside the
 * rows so a view can list its returnable columns without reading any. A rule's paths are exactly
 * `rowLeafPaths` over every one of its findings that has stored rows, Fixed included, so a column
 * only a now-Fixed finding returned is still offered.
 */

/** The distinct paths for `ruleIds` (every rule when omitted), sorted, read on `handle`. An empty
 *  list of rules has no columns. */
export async function listReturnedColumnsIn(handle: DbHandle, ruleIds?: readonly string[]): Promise<string[]> {
  if (ruleIds && ruleIds.length === 0) return [];
  const paths = new Set<string>();
  const groups = ruleIds ? chunk([...new Set(ruleIds)]) : [undefined];
  for (const group of groups) {
    const query = handle.selectDistinct({ path: catalogueTable.path }).from(catalogueTable);
    const rows = await many(group ? query.where(inArray(catalogueTable.ruleId, group)) : query);
    for (const r of rows) paths.add(r.path);
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

/** The distinct paths for `ruleIds` (every rule when omitted), sorted with `localeCompare`. */
export function listReturnedColumns(ruleIds?: readonly string[]): Promise<string[]> {
  return listReturnedColumnsIn(db, ruleIds);
}

/** A finding whose rows a scan has just written, with them as the JSON text that was stored. */
export interface WrittenFinding { ruleId: string; fingerprint: string; data: readonly string[] }

/**
 * Brings the entries of every rule that has a finding in `written` up to date with the rows now
 * stored. Runs inside the caller's transaction, after the scan's own rows are written.
 *
 * A rule's paths are those of the rows just written plus those of the rows stored for its other
 * findings (one the scan kept or Fixed). The others' rows did not change, so whatever they hold the
 * rule's old entries already held. When the rows written hold every old entry, the answer is the
 * paths of the rows written and no stored row is read. Only when they do not, because the rewritten
 * rows dropped a column, are the others' rows read, to see which of the dropped columns they still
 * return. Before the catalogue has been proven built its old entries prove nothing, so they are read.
 * Only the entries that changed are written.
 */
export async function rebuildColumnCatalogue(tx: DbHandle, written: readonly WrittenFinding[]): Promise<void> {
  const byRule = new Map<string, WrittenFinding[]>();
  for (const f of written) {
    const list = byRule.get(f.ruleId);
    if (list) list.push(f);
    else byRule.set(f.ruleId, [f]);
  }
  if (byRule.size === 0) return;
  const built = (await one(tx.select().from(metaTable).where(eq(metaTable.key, COLUMN_CATALOGUE_MARKER)))) !== undefined;

  for (const [ruleId, findings] of byRule) {
    const collector = new PathCollector();
    for (const f of findings) for (const data of f.data) collector.add(data);
    let paths = collector.result();

    const old = (await many(tx.select({ path: catalogueTable.path }).from(catalogueTable).where(eq(catalogueTable.ruleId, ruleId))))
      .map(r => r.path);
    const have = new Set(paths);
    if (!built || old.some(path => !have.has(path))) {
      const writtenHere = new Set(findings.map(f => f.fingerprint));
      const others = (await many(tx.select({ fingerprint: findingsTable.fingerprint }).from(findingsTable).where(eq(findingsTable.ruleId, ruleId))))
        .map(r => r.fingerprint)
        .filter(fp => !writtenHere.has(fp));
      for (const fpChunk of chunk(others)) {
        const rows = await many(tx.select({ data: findingRowsTable.data }).from(findingRowsTable).where(inArray(findingRowsTable.fingerprint, fpChunk)));
        for (const r of rows) collector.add(r.data);
      }
      paths = collector.result();
    }

    const keep = new Set(paths);
    const had = new Set(old);
    const gone = old.filter(path => !keep.has(path));
    const added = paths.filter(path => !had.has(path));
    for (const pathChunk of chunk(gone)) {
      await run(tx.delete(catalogueTable).where(and(eq(catalogueTable.ruleId, ruleId), inArray(catalogueTable.path, pathChunk))));
    }
    // Two bound values an entry, under SQLite's 999.
    for (const pathChunk of chunk(added, 400)) {
      await run(tx.insert(catalogueTable).values(pathChunk.map(path => ({ ruleId, path }))));
    }
  }
}

/** Removes a rule's entries, for a caller that already holds a transaction. */
export async function removeColumnCatalogueForRule(tx: DbHandle, ruleId: string): Promise<void> {
  await run(tx.delete(catalogueTable).where(eq(catalogueTable.ruleId, ruleId)));
}
