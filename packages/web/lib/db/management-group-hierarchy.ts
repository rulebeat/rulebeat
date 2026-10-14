import { eq } from 'drizzle-orm';
import { db } from './client';
import { managementGroupHierarchy as hierarchyTable, meta as metaTable } from './tables';
import { inTransaction, many, one, run, type DbHandle } from './exec';
import {
  NEVER_REFRESHED, refreshError, type HierarchyKind, type HierarchyNode, type HierarchyStatus, type RefreshErrorCode,
} from '../management-group-tree';

/** The `meta` key the refresh status is kept under, as one JSON value so it is written in one statement. */
export const HIERARCHY_STATUS_KEY = 'management_group_hierarchy_status';

interface StoredStatus {
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  errorCode: RefreshErrorCode | null;
}

function isKind(value: string): value is HierarchyKind {
  return value === 'managementGroup' || value === 'subscription';
}

/** Every stored node. A row whose kind is not one this release knows is left out. */
export async function listHierarchyNodes(): Promise<HierarchyNode[]> {
  const rows = await many(db.select().from(hierarchyTable));
  const nodes: HierarchyNode[] = [];
  for (const row of rows) {
    if (!isKind(row.kind)) continue;
    nodes.push({ tenantId: row.tenantId, kind: row.kind, id: row.nodeId, name: row.displayName, parentId: row.parentId });
  }
  return nodes;
}

function parseStatus(raw: string | null): HierarchyStatus {
  if (!raw) return NEVER_REFRESHED;
  try {
    const stored = JSON.parse(raw) as Partial<StoredStatus>;
    const code = stored.errorCode === 'azure_not_configured' || stored.errorCode === 'failed' ? stored.errorCode : null;
    return {
      lastSuccessAt: typeof stored.lastSuccessAt === 'string' ? stored.lastSuccessAt : null,
      lastAttemptAt: typeof stored.lastAttemptAt === 'string' ? stored.lastAttemptAt : null,
      error: code ? refreshError(code) : null,
    };
  } catch {
    return NEVER_REFRESHED;
  }
}

export async function getHierarchyStatus(): Promise<HierarchyStatus> {
  const row = await one(db.select().from(metaTable).where(eq(metaTable.key, HIERARCHY_STATUS_KEY)));
  return parseStatus(row?.value ?? null);
}

async function writeStatus(tx: DbHandle, status: StoredStatus): Promise<void> {
  const value = JSON.stringify(status);
  await run(tx.insert(metaTable).values({ key: HIERARCHY_STATUS_KEY, value })
    .onConflictDoUpdate({ target: metaTable.key, set: { value } }));
}

/** Two nodes are the same row when they differ only by case, as every comparison of ids is. */
function distinctNodes(nodes: readonly HierarchyNode[]): HierarchyNode[] {
  const seen = new Set<string>();
  const out: HierarchyNode[] = [];
  for (const node of nodes) {
    const key = `${node.tenantId}|${node.kind}|${node.id.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(node);
  }
  return out;
}

/**
 * Replaces the whole tree with what a read returned and records the success, in one transaction: a
 * person never sees half of one tree and half of another, and a failure part-way leaves the old tree.
 */
export async function replaceHierarchy(nodes: readonly HierarchyNode[], at: string): Promise<void> {
  const rows = distinctNodes(nodes);
  await inTransaction(async tx => {
    await run(tx.delete(hierarchyTable));
    for (const node of rows) {
      await run(tx.insert(hierarchyTable).values({
        tenantId: node.tenantId, kind: node.kind, nodeId: node.id, displayName: node.name, parentId: node.parentId,
      }));
    }
    await writeStatus(tx, { lastSuccessAt: at, lastAttemptAt: at, errorCode: null });
  });
}

/** Records a failed attempt. The tree and the time of the last success stay as they were. */
export async function recordFailedAttempt(code: RefreshErrorCode, at: string): Promise<void> {
  await inTransaction(async tx => {
    const row = await one(tx.select().from(metaTable).where(eq(metaTable.key, HIERARCHY_STATUS_KEY)));
    const previous = parseStatus(row?.value ?? null);
    await writeStatus(tx, { lastSuccessAt: previous.lastSuccessAt, lastAttemptAt: at, errorCode: code });
  });
}
