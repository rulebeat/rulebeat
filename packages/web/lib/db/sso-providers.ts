import { db } from './client';
import { ssoProviders } from './schema';
import { eq } from 'drizzle-orm';
import { decryptSecret, encryptSecret } from '@/lib/secret-box';

/**
 * The SSO provider configured through Settings → Sign-in. See `lib/sign-in-config.ts` for how
 * this fits into resolution — environment variables always win over anything stored here, exactly
 * like `lib/db/azure-credentials.ts`, whose structure this file copies literally.
 */

/** Internal shape. Carries the decrypted secret and must never be returned from an API route. */
export interface StoredSsoProvider {
  id: string;
  provider: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  isActive: boolean;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

/** What a client is allowed to see. The secret is absent by construction, not filtered out later. */
export interface SsoProviderSummary {
  id: string;
  provider: string;
  tenantId: string;
  clientId: string;
  secretSet: boolean;
  secretUnreadable: boolean;
  isActive: boolean;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

type Row = typeof ssoProviders.$inferSelect;

function rowToSummary(row: Row): SsoProviderSummary {
  return {
    id: row.id,
    provider: row.provider,
    tenantId: row.tenantId,
    clientId: row.clientId,
    secretSet: row.clientSecret.length > 0,
    secretUnreadable: decryptSecret(row.clientSecret) === null,
    isActive: row.isActive,
    lastVerifiedAt: row.lastVerifiedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy ?? null,
  };
}

/** The single stored provider, if any — today's model is "at most one SSO provider configured". */
export function getStoredSsoProviderSummary(): SsoProviderSummary | null {
  const row = db.select().from(ssoProviders).limit(1).get();
  return row ? rowToSummary(row) : null;
}

/**
 * The stored provider with its secret decrypted, for actually building a NextAuth provider.
 *
 * Returns null when the secret can't be opened (rotated or lost key), same reasoning as
 * `getActiveAzureCredential` — the caller falls through to "not configured" rather than handing
 * back ciphertext that would fail every sign-in with a baffling error.
 */
export function getStoredSsoProvider(): StoredSsoProvider | null {
  const row = db.select().from(ssoProviders).limit(1).get();
  if (!row) return null;

  const clientSecret = decryptSecret(row.clientSecret);
  if (clientSecret === null) return null;

  return { ...rowToSummary(row), clientSecret } as StoredSsoProvider;
}

export interface SaveSsoProviderInput {
  provider: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  createdBy?: string;
}

/**
 * Stores (or replaces) the one SSO provider row. Always saved inactive — see the design note in
 * the B1b plan on why sign-in config is verified by a real sign-in, not a credentials probe: a
 * client-credentials check can't see the redirect URI, which is the most common Entra setup
 * failure, so a green tick here would be no guarantee the login button actually works.
 */
export function saveSsoProvider(input: SaveSsoProviderInput): SsoProviderSummary {
  const now = new Date().toISOString();
  const tenantId = input.tenantId.trim();
  const clientId = input.clientId.trim();

  return db.transaction(tx => {
    const existing = tx.select().from(ssoProviders).limit(1).get();

    if (existing) {
      tx.update(ssoProviders).set({
        provider: input.provider,
        tenantId,
        clientId,
        clientSecret: encryptSecret(input.clientSecret),
        isActive: false,
        lastVerifiedAt: null,
        updatedAt: now,
        ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      }).where(eq(ssoProviders.id, existing.id)).run();

      return rowToSummary(tx.select().from(ssoProviders).where(eq(ssoProviders.id, existing.id)).get()!);
    }

    const id = globalThis.crypto.randomUUID();
    tx.insert(ssoProviders).values({
      id,
      provider: input.provider,
      tenantId,
      clientId,
      clientSecret: encryptSecret(input.clientSecret),
      isActive: false,
      lastVerifiedAt: null,
      createdAt: now,
      updatedAt: now,
      createdBy: input.createdBy ?? null,
    }).run();

    return rowToSummary(tx.select().from(ssoProviders).where(eq(ssoProviders.id, id)).get()!);
  });
}

export function deleteSsoProvider(id: string): boolean {
  const existing = db.select().from(ssoProviders).where(eq(ssoProviders.id, id)).get();
  if (!existing) return false;
  db.delete(ssoProviders).where(eq(ssoProviders.id, id)).run();
  return true;
}

/**
 * Flips a stored-but-unverified row active on its first successful sign-in. Called from `auth.ts`'s
 * `signIn` callback — a real OAuth round trip is a strictly stronger proof than any probe this
 * product could run ahead of time.
 */
export function markSsoProviderVerified(id: string): void {
  db.update(ssoProviders).set({
    isActive: true,
    lastVerifiedAt: new Date().toISOString(),
  }).where(eq(ssoProviders.id, id)).run();
}
