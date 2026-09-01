import { db } from './client';
import { notificationChannels } from './tables';
import { eq, asc } from 'drizzle-orm';
import { decryptSecret, encryptSecret } from '@/lib/secret-box';
import { deleteDeliveriesForChannel } from './notification-deliveries';
import { many, one, run } from './exec';

/**
 * Outbound notification channel address book. One row per destination URL; severity threshold
 * and scope live in schedule_notification_channels, not here.
 *
 * For webhook types (teams/slack/webhook):
 *   - `url` = AES-256-GCM encrypted webhook URL
 *   - `config` = null
 *
 * For email:
 *   - `url` = AES-256-GCM encrypted SMTP password (may be empty for anonymous relays)
 *   - `config` = JSON: EmailChannelConfig (non-secret fields only)
 */

export type NotificationChannelType = 'teams' | 'slack' | 'webhook' | 'email';

/** SMTP configuration for email channels. The password is stored separately in `url`. */
export interface EmailChannelConfig {
  host: string;
  port: number;
  tls: 'none' | 'starttls' | 'tls';
  username: string;
  fromAddress: string;
  toAddresses: string; // comma-separated list of recipient addresses
}

/** Internal shape. Carries the decrypted secret and must never be returned from an API route. */
export interface StoredNotificationChannel {
  id: string;
  name: string;
  type: NotificationChannelType;
  url: string;             // decrypted: webhook URL for webhook types, SMTP password for email
  emailConfig: EmailChannelConfig | null;
  createdAt: string;
  updatedAt: string;
  lastNotifiedAt: string | null;
  lastError: string | null;
}

/** What a client is allowed to see. The secret is absent by construction. */
export interface NotificationChannelSummary {
  id: string;
  name: string;
  type: NotificationChannelType;
  /** Webhook hostname or "smtp.host:port" for email — enough for display, not enough to call. */
  urlHost: string;
  emailConfig: EmailChannelConfig | null;
  createdAt: string;
  updatedAt: string;
  lastNotifiedAt: string | null;
  lastError: string | null;
}

type Row = typeof notificationChannels.$inferSelect;

function parseEmailConfig(raw: string | null): EmailChannelConfig | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as EmailChannelConfig; } catch { return null; }
}

function safeHost(row: Row): string {
  if (row.type === 'email') {
    const cfg = parseEmailConfig(row.config ?? null);
    if (!cfg) return '(no config)';
    return `${cfg.host}:${cfg.port}`;
  }
  try {
    const url = decryptSecret(row.url);
    if (!url) return '(url unreadable)';
    return new URL(url).hostname;
  } catch {
    return '(invalid url)';
  }
}

function rowToSummary(row: Row): NotificationChannelSummary {
  return {
    id: row.id,
    name: row.name,
    type: row.type as NotificationChannelType,
    urlHost: safeHost(row),
    emailConfig: parseEmailConfig(row.config ?? null),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastNotifiedAt: row.lastNotifiedAt ?? null,
    lastError: row.lastError ?? null,
  };
}

/** Returns the decrypted channel for dispatching. Returns null if the secret can't be decrypted. */
export function rowToStoredChannel(row: Row): StoredNotificationChannel | null {
  const url = decryptSecret(row.url);
  if (url === null) return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type as NotificationChannelType,
    url,
    emailConfig: parseEmailConfig(row.config ?? null),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastNotifiedAt: row.lastNotifiedAt ?? null,
    lastError: row.lastError ?? null,
  };
}

export async function listChannels(): Promise<NotificationChannelSummary[]> {
  const rows = await many(
    db.select().from(notificationChannels).orderBy(asc(notificationChannels.createdAt)),
  );
  return rows.map(rowToSummary);
}

export async function getChannelSummary(id: string): Promise<NotificationChannelSummary | null> {
  const row = await one(
    db.select().from(notificationChannels).where(eq(notificationChannels.id, id)),
  );
  return row ? rowToSummary(row) : null;
}

export async function getStoredChannel(id: string): Promise<StoredNotificationChannel | null> {
  const row = await one(
    db.select().from(notificationChannels).where(eq(notificationChannels.id, id)),
  );
  return row ? rowToStoredChannel(row) : null;
}

export interface SaveChannelInput {
  name: string;
  type: NotificationChannelType;
  url: string;                      // webhook URL or SMTP password (may be empty for anonymous SMTP)
  config?: EmailChannelConfig;      // required when type === 'email', absent otherwise
}

export async function createChannel(input: SaveChannelInput): Promise<NotificationChannelSummary> {
  const now = new Date().toISOString();
  const id = globalThis.crypto.randomUUID();
  await run(db.insert(notificationChannels).values({
    id,
    name: input.name.trim(),
    type: input.type,
    url: encryptSecret(input.url.trim()),
    config: input.config ? JSON.stringify(input.config) : null,
    createdAt: now,
    updatedAt: now,
    lastNotifiedAt: null,
    lastError: null,
  }));
  const row = await one(
    db.select().from(notificationChannels).where(eq(notificationChannels.id, id)),
  );
  return rowToSummary(row!);
}

export async function updateChannel(id: string, input: Partial<SaveChannelInput>): Promise<NotificationChannelSummary | null> {
  const row = await one(db.select().from(notificationChannels).where(eq(notificationChannels.id, id)));
  if (!row) return null;

  const updates: Partial<Row> = { updatedAt: new Date().toISOString() };
  if (input.name !== undefined) updates.name = input.name.trim();
  if (input.type !== undefined) updates.type = input.type;
  if (input.url !== undefined && input.url.trim()) updates.url = encryptSecret(input.url.trim());
  if (input.config !== undefined) updates.config = input.config ? JSON.stringify(input.config) : null;

  await run(db.update(notificationChannels).set(updates).where(eq(notificationChannels.id, id)));
  const updated = await one(
    db.select().from(notificationChannels).where(eq(notificationChannels.id, id)),
  );
  return rowToSummary(updated!);
}

export async function deleteChannel(id: string): Promise<boolean> {
  const existing = await one(db.select().from(notificationChannels).where(eq(notificationChannels.id, id)));
  if (!existing) return false;
  await run(db.delete(notificationChannels).where(eq(notificationChannels.id, id)));
  await deleteDeliveriesForChannel(id);
  return true;
}

export async function recordChannelResult(id: string, result: { ok: boolean; error?: string }): Promise<void> {
  const now = new Date().toISOString();
  await run(db.update(notificationChannels).set({
    lastNotifiedAt: result.ok ? now : undefined,
    lastError: result.ok ? null : (result.error ?? 'Unknown error'),
    updatedAt: now,
  }).where(eq(notificationChannels.id, id)));
}
