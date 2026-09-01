import { db } from './client';
import { auditLog } from './tables';
import { desc, count } from 'drizzle-orm';
import { many, one, run } from './exec';
import type { AppUser } from './users';

export type AuditAction =
  | 'rule.create' | 'rule.update' | 'rule.delete' | 'rule.duplicate' | 'rule.bulk_update'
  | 'suppression.create' | 'suppression.delete'
  | 'schedule.create' | 'schedule.update' | 'schedule.delete' | 'schedule.run'
  | 'category.create' | 'category.update' | 'category.delete'
  | 'dashboard.create' | 'dashboard.rename' | 'dashboard.delete' | 'dashboard.duplicate'
  | 'scan.run'
  | 'user.invite' | 'user.invite_claimed' | 'user.role_change' | 'user.remove' | 'user.default_role_change'
  | 'user.password_set' | 'user.password_reset' | 'user.password_removed'
  | 'azure_connection.save' | 'azure_connection.delete' | 'azure_connection.test'
  | 'log_analytics_workspace.save' | 'log_analytics_workspace.delete'
  | 'auth.sign_in' | 'auth.sign_in_failed' | 'auth.locked_out'
  | 'sign_in_config.save' | 'sign_in_config.delete' | 'sign_in_config.test'
  | 'sign_in_config.policy_change'
  | 'sign_in_config.public_url_set' | 'sign_in_config.public_url_clear'
  | 'notification_channel.create' | 'notification_channel.update' | 'notification_channel.delete'
  | 'notification_channel.test'
  | 'onboarding.skip' | 'onboarding.complete'
  | 'schema_cache.refresh'
  | 'query.run' | 'query.save' | 'query.delete';

export type AuditEntityType =
  | 'rule' | 'suppression' | 'schedule' | 'category' | 'dashboard' | 'scan' | 'user' | 'auth'
  | 'azure_connection' | 'log_analytics_workspace' | 'local_account' | 'sign_in_config'
  | 'notification_channel' | 'onboarding' | 'schema_cache' | 'query';

export interface AuditEntry {
  id: string;
  actorId: string;
  actorEmail: string;
  action: AuditAction;
  entityType: AuditEntityType | null;
  entityId: string | null;
  summary: string;
  details: Record<string, unknown> | null;
  occurredAt: string;
}

type Row = typeof auditLog.$inferSelect;

function rowToEntry(row: Row): AuditEntry {
  let details: Record<string, unknown> | null = null;
  if (row.details) {
    try { details = JSON.parse(row.details) as Record<string, unknown>; } catch { details = null; }
  }
  return {
    id: row.id,
    actorId: row.actorId,
    actorEmail: row.actorEmail,
    action: row.action as AuditAction,
    entityType: (row.entityType as AuditEntityType) ?? null,
    entityId: row.entityId ?? null,
    summary: row.summary,
    details,
    occurredAt: row.occurredAt,
  };
}

export interface WriteAuditInput {
  actor: Pick<AppUser, 'id' | 'email'>;
  action: AuditAction;
  entityType?: AuditEntityType;
  entityId?: string;
  summary: string;
  /**
   * Changed field *names* and other small facts — never the field values. A rule's before/after
   * JSON is several KB of mostly noise; the field list answers "who changed what" without turning
   * the audit log into a second copy of the database.
   */
  details?: Record<string, unknown>;
}

/**
 * Records one action. Best-effort and never throws — a failed audit write must not turn a
 * successful operation into an error response for the user. A failure is no longer silent: it
 * goes to stdout in the same structured shape lib/server-logger.ts's createScanLogger() uses, so
 * an operator watching logs (or piping them to their own aggregator) still sees it even though
 * the row itself is lost.
 */
export async function writeAudit(input: WriteAuditInput): Promise<void> {
  try {
    await run(db.insert(auditLog).values({
      id: globalThis.crypto.randomUUID(),
      actorId: input.actor.id,
      actorEmail: input.actor.email,
      action: input.action,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      summary: input.summary,
      details: input.details ? JSON.stringify(input.details) : null,
      occurredAt: new Date().toISOString(),
    }));
  } catch (err) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      message: 'audit write failed',
      action: input.action,
      error: String(err),
    }));
  }
}

/**
 * Logs an authentication event that must never persist to audit_log: a sign-in attempt that never
 * resolved to a bounded, real account (unknown email, an account with no local password, a
 * repeated request against an already-locked-out account, or a denied SSO sign-in). Persisting
 * these lets anyone who can reach the sign-in endpoint grow audit_log without limit just by
 * retrying — see spec 022. Goes to stdout only, same structured shape as writeAudit()'s failure
 * log, so the signal (enumeration, brute-force, lockout probing) is still visible to an operator.
 */
export function logAuthEvent(message: string, fields?: Record<string, unknown>): void {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'warn',
    message,
    ...fields,
  }));
}

export async function listAuditEntries(opts: { limit?: number; offset?: number } = {}): Promise<AuditEntry[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const rows = await many(
    db.select().from(auditLog)
      .orderBy(desc(auditLog.occurredAt))
      .limit(limit).offset(offset),
  );
  return rows.map(rowToEntry);
}

/** Every row, unpaginated — for CSV export. listAuditEntries() stays capped at 200 for the UI. */
export async function listAllAuditEntries(): Promise<AuditEntry[]> {
  const rows = await many(
    db.select().from(auditLog).orderBy(desc(auditLog.occurredAt)),
  );
  return rows.map(rowToEntry);
}

export async function countAuditEntries(): Promise<number> {
  const row = await one(db.select({ n: count() }).from(auditLog));
  return row?.n ?? 0;
}

/**
 * The field names that differ between an existing record and an incoming update, for `details`.
 * Compared by serialized value so nested arrays/objects (conditions, scope, tags) work too.
 */
export function changedFields<T extends object>(before: T, after: Partial<T>): string[] {
  return Object.keys(after).filter(key => {
    const k = key as keyof T;
    return JSON.stringify(after[k]) !== JSON.stringify(before[k]);
  });
}
