import { db } from './client';
import { logAnalyticsWorkspaces } from './tables';
import { eq, asc } from 'drizzle-orm';
import { many, one, run, inTransaction } from './exec';

/**
 * The default Log Analytics workspace entered through the UI. See `lib/log-analytics-workspace.ts`
 * for how this fits into resolution — an environment variable always wins over anything stored here.
 *
 * Unlike azureCredentials, there is no secret on this row: a workspace query is authorized by the
 * existing Azure credential (Log Analytics Reader on the workspace), not a separate identity. The
 * table still allows several rows so that a second workspace later is a new record, but exactly one
 * is active at a time and the UI only ever manages that one.
 */

export interface LogAnalyticsWorkspaceSummary {
  id: string;
  name: string;
  workspaceId: string;
  isActive: boolean;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

type Row = typeof logAnalyticsWorkspaces.$inferSelect;

function rowToSummary(row: Row): LogAnalyticsWorkspaceSummary {
  return {
    id: row.id,
    name: row.name,
    workspaceId: row.workspaceId,
    isActive: row.isActive,
    lastVerifiedAt: row.lastVerifiedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy ?? null,
  };
}

export async function listLogAnalyticsWorkspaces(): Promise<LogAnalyticsWorkspaceSummary[]> {
  const rows = await many(
    db.select().from(logAnalyticsWorkspaces).orderBy(asc(logAnalyticsWorkspaces.createdAt)),
  );
  return rows.map(rowToSummary);
}

export async function getActiveLogAnalyticsWorkspace(): Promise<LogAnalyticsWorkspaceSummary | null> {
  const row = await one(
    db.select().from(logAnalyticsWorkspaces).where(eq(logAnalyticsWorkspaces.isActive, true)),
  );
  return row ? rowToSummary(row) : null;
}

export interface SaveLogAnalyticsWorkspaceInput {
  name?: string;
  workspaceId: string;
  createdBy?: string;
}

/**
 * Stores (or replaces) the active workspace. Any previously active row is deactivated in the same
 * transaction, so "the active workspace" can never be ambiguous.
 */
export async function saveLogAnalyticsWorkspace(input: SaveLogAnalyticsWorkspaceInput): Promise<LogAnalyticsWorkspaceSummary> {
  const now = new Date().toISOString();
  const workspaceId = input.workspaceId.trim();
  const name = input.name?.trim() || `Workspace ${workspaceId}`;

  return inTransaction(async (tx) => {
    const existing = await one(
      tx.select().from(logAnalyticsWorkspaces).where(eq(logAnalyticsWorkspaces.isActive, true)),
    );

    if (existing) {
      await run(tx.update(logAnalyticsWorkspaces).set({
        name,
        workspaceId,
        updatedAt: now,
        // A new workspace id invalidates whatever the last check proved.
        lastVerifiedAt: null,
        ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      }).where(eq(logAnalyticsWorkspaces.id, existing.id)));

      const updated = await one(
        tx.select().from(logAnalyticsWorkspaces).where(eq(logAnalyticsWorkspaces.id, existing.id)),
      );
      return rowToSummary(updated!);
    }

    const id = globalThis.crypto.randomUUID();
    await run(tx.insert(logAnalyticsWorkspaces).values({
      id,
      name,
      workspaceId,
      isActive: true,
      lastVerifiedAt: null,
      createdAt: now,
      updatedAt: now,
      createdBy: input.createdBy ?? null,
    }));

    const created = await one(
      tx.select().from(logAnalyticsWorkspaces).where(eq(logAnalyticsWorkspaces.id, id)),
    );
    return rowToSummary(created!);
  });
}

export async function deleteLogAnalyticsWorkspace(id: string): Promise<boolean> {
  const existing = await one(db.select().from(logAnalyticsWorkspaces).where(eq(logAnalyticsWorkspaces.id, id)));
  if (!existing) return false;
  await run(db.delete(logAnalyticsWorkspaces).where(eq(logAnalyticsWorkspaces.id, id)));
  return true;
}

/** Records that this workspace really answered a query. */
export async function markLogAnalyticsWorkspaceVerified(id: string): Promise<void> {
  await run(db.update(logAnalyticsWorkspaces).set({
    lastVerifiedAt: new Date().toISOString(),
  }).where(eq(logAnalyticsWorkspaces.id, id)));
}
