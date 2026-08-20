import { db } from './client';
import { logAnalyticsWorkspaces } from './schema';
import { eq, asc } from 'drizzle-orm';

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

export function listLogAnalyticsWorkspaces(): LogAnalyticsWorkspaceSummary[] {
  return db.select().from(logAnalyticsWorkspaces)
    .orderBy(asc(logAnalyticsWorkspaces.createdAt))
    .all().map(rowToSummary);
}

export function getActiveLogAnalyticsWorkspace(): LogAnalyticsWorkspaceSummary | null {
  const row = db.select().from(logAnalyticsWorkspaces)
    .where(eq(logAnalyticsWorkspaces.isActive, true)).get();
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
export function saveLogAnalyticsWorkspace(input: SaveLogAnalyticsWorkspaceInput): LogAnalyticsWorkspaceSummary {
  const now = new Date().toISOString();
  const workspaceId = input.workspaceId.trim();
  const name = input.name?.trim() || `Workspace ${workspaceId}`;

  return db.transaction(tx => {
    const existing = tx.select().from(logAnalyticsWorkspaces)
      .where(eq(logAnalyticsWorkspaces.isActive, true)).get();

    if (existing) {
      tx.update(logAnalyticsWorkspaces).set({
        name,
        workspaceId,
        updatedAt: now,
        // A new workspace id invalidates whatever the last check proved.
        lastVerifiedAt: null,
        ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      }).where(eq(logAnalyticsWorkspaces.id, existing.id)).run();

      return rowToSummary(
        tx.select().from(logAnalyticsWorkspaces).where(eq(logAnalyticsWorkspaces.id, existing.id)).get()!,
      );
    }

    const id = globalThis.crypto.randomUUID();
    tx.insert(logAnalyticsWorkspaces).values({
      id,
      name,
      workspaceId,
      isActive: true,
      lastVerifiedAt: null,
      createdAt: now,
      updatedAt: now,
      createdBy: input.createdBy ?? null,
    }).run();

    return rowToSummary(
      tx.select().from(logAnalyticsWorkspaces).where(eq(logAnalyticsWorkspaces.id, id)).get()!,
    );
  });
}

export function deleteLogAnalyticsWorkspace(id: string): boolean {
  const existing = db.select().from(logAnalyticsWorkspaces).where(eq(logAnalyticsWorkspaces.id, id)).get();
  if (!existing) return false;
  db.delete(logAnalyticsWorkspaces).where(eq(logAnalyticsWorkspaces.id, id)).run();
  return true;
}

/** Records that this workspace really answered a query. */
export function markLogAnalyticsWorkspaceVerified(id: string): void {
  db.update(logAnalyticsWorkspaces).set({
    lastVerifiedAt: new Date().toISOString(),
  }).where(eq(logAnalyticsWorkspaces.id, id)).run();
}
