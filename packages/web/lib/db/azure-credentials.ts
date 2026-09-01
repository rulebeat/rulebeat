import { db } from './client';
import { azureCredentials } from './tables';
import { eq, asc } from 'drizzle-orm';
import { many, one, run, inTransaction } from './exec';
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

export async function listAzureCredentials(): Promise<AzureCredentialSummary[]> {
  const rows = await many(
    db.select().from(azureCredentials).orderBy(asc(azureCredentials.createdAt)),
  );
  return rows.map(rowToSummary);
}

export async function getActiveAzureCredentialSummary(): Promise<AzureCredentialSummary | null> {
  const row = await one(db.select().from(azureCredentials).where(eq(azureCredentials.isActive, true)));
  return row ? rowToSummary(row) : null;
}

/**
 * The active credential with its secret decrypted, for actually calling Azure.
 *
 * Returns null when the secret can't be opened (rotated or lost key) rather than handing back
 * ciphertext that would fail authentication with a baffling error — the caller falls through to the
 * next credential source, and the UI reports the credential as needing re-entry.
 */
export async function getActiveAzureCredential(): Promise<StoredAzureCredential | null> {
  const row = await one(db.select().from(azureCredentials).where(eq(azureCredentials.isActive, true)));
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
export async function saveAzureCredential(input: SaveAzureCredentialInput): Promise<AzureCredentialSummary> {
  const now = new Date().toISOString();
  const tenantId = input.tenantId.trim();
  const clientId = input.clientId.trim();
  const name = input.name?.trim() || `Tenant ${tenantId}`;

  return inTransaction(async (tx) => {
    const existing = await one(
      tx.select().from(azureCredentials).where(eq(azureCredentials.isActive, true)),
    );

    if (existing) {
      await run(tx.update(azureCredentials).set({
        name,
        tenantId,
        clientId,
        clientSecret: encryptSecret(input.clientSecret),
        updatedAt: now,
        // A new secret invalidates whatever the last check proved.
        lastVerifiedAt: null,
        lastVerifiedSubscriptions: null,
        ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      }).where(eq(azureCredentials.id, existing.id)));

      const updated = await one(
        tx.select().from(azureCredentials).where(eq(azureCredentials.id, existing.id)),
      );
      return rowToSummary(updated!);
    }

    const id = globalThis.crypto.randomUUID();
    await run(tx.insert(azureCredentials).values({
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
    }));

    const created = await one(
      tx.select().from(azureCredentials).where(eq(azureCredentials.id, id)),
    );
    return rowToSummary(created!);
  });
}

export async function deleteAzureCredential(id: string): Promise<boolean> {
  const existing = await one(db.select().from(azureCredentials).where(eq(azureCredentials.id, id)));
  if (!existing) return false;
  await run(db.delete(azureCredentials).where(eq(azureCredentials.id, id)));
  return true;
}

/** Records that this credential really reached Azure, and how much it could see. */
export async function markAzureCredentialVerified(id: string, subscriptionCount: number): Promise<void> {
  await run(db.update(azureCredentials).set({
    lastVerifiedAt: new Date().toISOString(),
    lastVerifiedSubscriptions: subscriptionCount,
  }).where(eq(azureCredentials.id, id)));
}
