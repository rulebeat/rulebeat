import { db } from './client';
import { azureCredentials } from './schema';
import { eq, asc } from 'drizzle-orm';
import { decryptSecret, encryptSecret } from '@/lib/secret-box';

/**
 * The Azure service principal entered through the UI. See `lib/azure-credential.ts` for how this
 * fits into credential resolution — environment variables always win over anything stored here.
 *
 * The table allows several rows so that scanning a second tenant later is a new record rather than a
 * migration, but exactly one is active at a time and the UI only ever manages that one.
 */

/** Internal shape. Carries the decrypted secret and must never be returned from an API route. */
export interface StoredAzureCredential {
  id: string;
  name: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  isActive: boolean;
  lastVerifiedAt: string | null;
  lastVerifiedSubscriptions: number | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

/** What a client is allowed to see. The secret is absent by construction, not filtered out later. */
export interface AzureCredentialSummary {
  id: string;
  name: string;
  tenantId: string;
  clientId: string;
  /** Whether a secret is on file. The secret itself never leaves the server. */
  secretSet: boolean;
  /** True when the stored secret can no longer be decrypted — the key was rotated or lost. */
  secretUnreadable: boolean;
  isActive: boolean;
  lastVerifiedAt: string | null;
  lastVerifiedSubscriptions: number | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

type Row = typeof azureCredentials.$inferSelect;

function rowToSummary(row: Row): AzureCredentialSummary {
  return {
    id: row.id,
    name: row.name,
    tenantId: row.tenantId,
    clientId: row.clientId,
    secretSet: row.clientSecret.length > 0,
    secretUnreadable: decryptSecret(row.clientSecret) === null,
    isActive: row.isActive,
    lastVerifiedAt: row.lastVerifiedAt ?? null,
    lastVerifiedSubscriptions: row.lastVerifiedSubscriptions ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy ?? null,
  };
}

export function listAzureCredentials(): AzureCredentialSummary[] {
  return db.select().from(azureCredentials)
    .orderBy(asc(azureCredentials.createdAt))
    .all().map(rowToSummary);
}

export function getActiveAzureCredentialSummary(): AzureCredentialSummary | null {
  const row = db.select().from(azureCredentials).where(eq(azureCredentials.isActive, true)).get();
  return row ? rowToSummary(row) : null;
}

/**
 * The active credential with its secret decrypted, for actually calling Azure.
 *
 * Returns null when the secret can't be opened (rotated or lost key) rather than handing back
 * ciphertext that would fail authentication with a baffling error — the caller falls through to the
 * next credential source, and the UI reports the credential as needing re-entry.
 */
export function getActiveAzureCredential(): StoredAzureCredential | null {
  const row = db.select().from(azureCredentials).where(eq(azureCredentials.isActive, true)).get();
  if (!row) return null;

  const clientSecret = decryptSecret(row.clientSecret);
  if (clientSecret === null) return null;

  return { ...rowToSummary(row), clientSecret } as StoredAzureCredential;
}

export interface SaveAzureCredentialInput {
  name?: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  createdBy?: string;
}

/**
 * Stores (or replaces) the active credential. Any previously active row is deactivated in the same
 * transaction, so "the active credential" can never be ambiguous.
 */
export function saveAzureCredential(input: SaveAzureCredentialInput): AzureCredentialSummary {
  const now = new Date().toISOString();
  const tenantId = input.tenantId.trim();
  const clientId = input.clientId.trim();
  const name = input.name?.trim() || `Tenant ${tenantId}`;

  return db.transaction(tx => {
    const existing = tx.select().from(azureCredentials)
      .where(eq(azureCredentials.isActive, true)).get();

    if (existing) {
      tx.update(azureCredentials).set({
        name,
        tenantId,
        clientId,
        clientSecret: encryptSecret(input.clientSecret),
        updatedAt: now,
        // A new secret invalidates whatever the last check proved.
        lastVerifiedAt: null,
        lastVerifiedSubscriptions: null,
        ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      }).where(eq(azureCredentials.id, existing.id)).run();

      return rowToSummary(
        tx.select().from(azureCredentials).where(eq(azureCredentials.id, existing.id)).get()!,
      );
    }

    const id = globalThis.crypto.randomUUID();
    tx.insert(azureCredentials).values({
      id,
      name,
      tenantId,
      clientId,
      clientSecret: encryptSecret(input.clientSecret),
      isActive: true,
      lastVerifiedAt: null,
      lastVerifiedSubscriptions: null,
      createdAt: now,
      updatedAt: now,
      createdBy: input.createdBy ?? null,
    }).run();

    return rowToSummary(
      tx.select().from(azureCredentials).where(eq(azureCredentials.id, id)).get()!,
    );
  });
}

export function deleteAzureCredential(id: string): boolean {
  const existing = db.select().from(azureCredentials).where(eq(azureCredentials.id, id)).get();
  if (!existing) return false;
  db.delete(azureCredentials).where(eq(azureCredentials.id, id)).run();
  return true;
}

/** Records that this credential really reached Azure, and how much it could see. */
export function markAzureCredentialVerified(id: string, subscriptionCount: number): void {
  db.update(azureCredentials).set({
    lastVerifiedAt: new Date().toISOString(),
    lastVerifiedSubscriptions: subscriptionCount,
  }).where(eq(azureCredentials.id, id)).run();
}
