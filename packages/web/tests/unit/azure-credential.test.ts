/**
 * Azure credential resolution and secret storage.
 *
 * The product now has three places a credential can come from, and the whole design rests on two
 * promises that nothing in the type system enforces:
 *
 *   1. environment variables always win, so an automated deployment can't be silently overridden by
 *      something an admin typed into the UI;
 *   2. a client secret entered in the UI is never written in plain text and never sent back to a
 *      browser.
 *
 * Both are asserted here against the real database and the real encryption, not against mocks — the
 * plaintext check in particular reads the raw SQLite column, because a repository that *said* it
 * encrypted and didn't would pass any test written against its own return value.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { dbKind } from '@/lib/db/backend';
import { dbReady, pgDb } from '@/lib/db/client';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decryptSecret,
  encryptSecret,
  isEncrypted,
  resetSecretBoxForTests,
} from '@/lib/secret-box';
import {
  getActiveAzureCredential,
  listAzureCredentials,
  saveAzureCredential,
  deleteAzureCredential,
} from '@/lib/db/azure-credentials';
import {
  AzureNotConfiguredError,
  getAzureConnectionStatus,
  readSecretFile,
  resolveAzureCredential,
} from '@/lib/azure-credential';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CLIENT = '22222222-2222-2222-2222-222222222222';
const SECRET = 'super-secret-value-Abc123~';

const ENV_KEYS = [
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_CLIENT_SECRET_FILE',
  'AZURE_CLIENT_CERTIFICATE_PATH',
  'AZURE_FEDERATED_TOKEN_FILE',
] as const;

/** Writes `contents` to a throwaway file and returns its path — stands in for a mounted secret. */
function secretFile(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'rulebeat-secret-')), 'azure_client_secret');
  writeFileSync(path, contents);
  return path;
}

let savedEnv: Record<string, string | undefined>;

async function clearStoredCredentials(): Promise<void> {
  for (const c of await listAzureCredentials()) await deleteAzureCredential(c.id);
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  await clearStoredCredentials();
});

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await clearStoredCredentials();
});

describe('secret-box · encryption at rest', () => {
  it('round-trips a secret', async () => {
    const sealed = encryptSecret(SECRET);
    expect(sealed).not.toContain(SECRET);
    expect(isEncrypted(sealed)).toBe(true);
    expect(decryptSecret(sealed)).toBe(SECRET);
  });

  it('produces a different ciphertext each time, so equal secrets are not recognisable', async () => {
    expect(encryptSecret(SECRET)).not.toBe(encryptSecret(SECRET));
  });

  it('refuses a tampered ciphertext rather than returning corrupted plaintext', async () => {
    const [prefix, iv, tag, ct] = encryptSecret(SECRET).split(':');
    const flipped = Buffer.from(ct!, 'base64');
    flipped[0] ^= 0xff;
    expect(decryptSecret([prefix, iv, tag, flipped.toString('base64')].join(':'))).toBeNull();
  });

  it('returns null — not a throw — when the key has changed', async () => {
    const sealed = encryptSecret(SECRET);
    const original = process.env.RULEBEAT_ENCRYPTION_KEY;
    try {
      process.env.RULEBEAT_ENCRYPTION_KEY = 'a-completely-different-key';
      resetSecretBoxForTests();
      // A lost or rotated key is an operational event, not a crash: the product's answer is
      // "re-enter this credential", which needs the read to fail softly.
      expect(decryptSecret(sealed)).toBeNull();
    } finally {
      process.env.RULEBEAT_ENCRYPTION_KEY = original;
      resetSecretBoxForTests();
    }
  });

  it('rejects malformed input without throwing', async () => {
    expect(decryptSecret('')).toBeNull();
    expect(decryptSecret('not-encrypted-at-all')).toBeNull();
    expect(decryptSecret('v1:only:three')).toBeNull();
    expect(decryptSecret('v2:a:b:c')).toBeNull();
  });

  // spec 023: RULEBEAT_ENCRYPTION_KEY_FILE — a mounted-secret path, same precedence as
  // AZURE_CLIENT_SECRET_FILE / AUTH_SECRET_FILE.
  describe('RULEBEAT_ENCRYPTION_KEY_FILE', () => {
    const originalKey = process.env.RULEBEAT_ENCRYPTION_KEY;
    const originalKeyFile = process.env.RULEBEAT_ENCRYPTION_KEY_FILE;

    afterEach(async () => {
      if (originalKey === undefined) delete process.env.RULEBEAT_ENCRYPTION_KEY;
      else process.env.RULEBEAT_ENCRYPTION_KEY = originalKey;
      if (originalKeyFile === undefined) delete process.env.RULEBEAT_ENCRYPTION_KEY_FILE;
      else process.env.RULEBEAT_ENCRYPTION_KEY_FILE = originalKeyFile;
      resetSecretBoxForTests();
    });

    it('wins over a simultaneously-set RULEBEAT_ENCRYPTION_KEY', async () => {
      process.env.RULEBEAT_ENCRYPTION_KEY_FILE = secretFile('from-the-mounted-key-file\n');
      process.env.RULEBEAT_ENCRYPTION_KEY = 'the-plain-env-key';
      resetSecretBoxForTests();
      const sealed = encryptSecret(SECRET);

      // Prove it was actually the file's key material that sealed this, not the plain var: change
      // the var and the ciphertext must still open, since the file should still be winning.
      process.env.RULEBEAT_ENCRYPTION_KEY = 'a-different-plain-env-key';
      resetSecretBoxForTests();
      expect(decryptSecret(sealed)).toBe(SECRET);
    });

    it('round-trips a secret using the file alone', async () => {
      process.env.RULEBEAT_ENCRYPTION_KEY_FILE = secretFile('  from-the-mounted-key-file  \n');
      delete process.env.RULEBEAT_ENCRYPTION_KEY;
      resetSecretBoxForTests();
      const sealed = encryptSecret(SECRET);
      expect(decryptSecret(sealed)).toBe(SECRET);
    });

    it('throws rather than encrypting with an empty key file', async () => {
      process.env.RULEBEAT_ENCRYPTION_KEY_FILE = secretFile('   \n');
      resetSecretBoxForTests();
      expect(() => encryptSecret(SECRET)).toThrow(/RULEBEAT_ENCRYPTION_KEY_FILE/);
    });
  });
});

describe('stored credentials · the secret never lands in plain text', () => {
  it('writes ciphertext to the database column, not the secret', async () => {
    await saveAzureCredential({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET });

    // Read the column directly. Asserting through the repository would only prove the repository is
    // self-consistent, which is exactly what a broken implementation would also be. On SQLite that
    // means a second, independent connection to the same file; on Postgres a raw SQL read.
    let stored: string;
    if (dbKind === 'pg') {
      await dbReady;
      const res = await pgDb!.execute(sql.raw('SELECT client_secret FROM azure_credentials'));
      stored = (res.rows[0] as { client_secret: string }).client_secret;
    } else {
      const raw = new Database(process.env.RULEBEAT_DB_PATH!, { readonly: true });
      try {
        stored = (raw.prepare('SELECT client_secret FROM azure_credentials').get() as { client_secret: string }).client_secret;
      } finally {
        raw.close();
      }
    }
    expect(stored).not.toContain(SECRET);
    expect(isEncrypted(stored)).toBe(true);
  });

  it('reads the secret back correctly for actually calling Azure', async () => {
    await saveAzureCredential({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET });
    expect((await getActiveAzureCredential())?.clientSecret).toBe(SECRET);
  });

  it('has no secret field at all on the shape the API returns', async () => {
    const summary = await saveAzureCredential({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET });
    // Not "the field is empty" — the field does not exist, so no handler can leak it by forgetting
    // to strip it.
    expect(Object.keys(summary)).not.toContain('clientSecret');
    expect(JSON.stringify(summary)).not.toContain(SECRET);
    expect(JSON.stringify(await getAzureConnectionStatus())).not.toContain(SECRET);
  });

  it('keeps exactly one credential active when a second is saved', async () => {
    await saveAzureCredential({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET });
    await saveAzureCredential({ tenantId: TENANT, clientId: CLIENT, clientSecret: 'a-newer-secret' });

    expect((await listAzureCredentials()).filter(c => c.isActive)).toHaveLength(1);
    expect((await getActiveAzureCredential())?.clientSecret).toBe('a-newer-secret');
  });

  it('clears the previous verification when the secret is replaced', async () => {
    const first = await saveAzureCredential({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET });
    expect(first.lastVerifiedAt).toBeNull();
    // A credential that was verified an hour ago proves nothing about the one just typed in.
    const second = await saveAzureCredential({ tenantId: TENANT, clientId: CLIENT, clientSecret: 'rotated' });
    expect(second.lastVerifiedAt).toBeNull();
  });
});

describe('credential resolution order', () => {
  it('uses the ambient chain when only a tenant is configured', async () => {
    process.env.AZURE_TENANT_ID = TENANT;
    const resolved = await resolveAzureCredential();
    expect(resolved.source).toBe('chain');
    expect(resolved.tenantId).toBe(TENANT);
  });

  it('prefers an environment service principal over the ambient chain', async () => {
    process.env.AZURE_TENANT_ID = TENANT;
    process.env.AZURE_CLIENT_ID = CLIENT;
    process.env.AZURE_CLIENT_SECRET = SECRET;
    expect((await resolveAzureCredential()).source).toBe('env-secret');
  });

  it('prefers a federated token over a client secret, since it is the keyless option', async () => {
    process.env.AZURE_TENANT_ID = TENANT;
    process.env.AZURE_CLIENT_ID = CLIENT;
    process.env.AZURE_CLIENT_SECRET = SECRET;
    process.env.AZURE_FEDERATED_TOKEN_FILE = '/var/run/secrets/azure/token';
    expect((await resolveAzureCredential()).source).toBe('env-federated');
  });

  it('prefers a mounted secret file over the same secret in a variable', async () => {
    // The variable is visible in `docker inspect`; the mounted file is not. When a deployment
    // supplies both — which happens mid-migration from one to the other — the safer one must win.
    process.env.AZURE_TENANT_ID = TENANT;
    process.env.AZURE_CLIENT_ID = CLIENT;
    process.env.AZURE_CLIENT_SECRET = SECRET;
    process.env.AZURE_CLIENT_SECRET_FILE = secretFile(SECRET);
    expect((await resolveAzureCredential()).source).toBe('env-secret-file');
  });

  it('strips the trailing newline that `echo > file` leaves behind', async () => {
    // Entra rejects a secret with a stray newline and reports only "invalid client secret", which
    // sends people looking at the app registration instead of at the extra byte. Asserted against
    // the reader itself, since a credential object won't hand back the secret it was built with.
    expect(readSecretFile(secretFile(`${SECRET}\n`))).toBe(SECRET);
    expect(readSecretFile(secretFile(`  ${SECRET}  `))).toBe(SECRET);
  });

  it('rejects an empty secret file instead of authenticating with an empty string', async () => {
    process.env.AZURE_TENANT_ID = TENANT;
    process.env.AZURE_CLIENT_ID = CLIENT;
    process.env.AZURE_CLIENT_SECRET_FILE = secretFile('   \n');
    await expect(resolveAzureCredential()).rejects.toThrow(AzureNotConfiguredError);
  });

  it('prefers a certificate over a client secret', async () => {
    process.env.AZURE_TENANT_ID = TENANT;
    process.env.AZURE_CLIENT_ID = CLIENT;
    process.env.AZURE_CLIENT_SECRET = SECRET;
    process.env.AZURE_CLIENT_CERTIFICATE_PATH = '/run/secrets/rulebeat.pem';
    expect((await resolveAzureCredential()).source).toBe('env-certificate');
  });

  it('uses a stored credential when the environment has none', async () => {
    await saveAzureCredential({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET });
    const resolved = await resolveAzureCredential();
    expect(resolved.source).toBe('stored');
    expect(resolved.tenantId).toBe(TENANT);
    expect(resolved.storedCredentialId).toBeDefined();
  });

  it('lets the environment override a stored credential', async () => {
    // The load-bearing case: an IaC or Marketplace deployment must not be quietly redirected by
    // something an admin typed into the UI, or the same template stops being reproducible.
    await saveAzureCredential({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET });
    process.env.AZURE_TENANT_ID = '33333333-3333-3333-3333-333333333333';
    process.env.AZURE_CLIENT_ID = CLIENT;
    process.env.AZURE_CLIENT_SECRET = 'from-the-environment';

    const resolved = await resolveAzureCredential();
    expect(resolved.source).toBe('env-secret');
    expect(resolved.tenantId).toBe('33333333-3333-3333-3333-333333333333');
  });

  it('ignores an empty environment variable rather than treating it as configured', async () => {
    // docker-compose writes `AZURE_CLIENT_ID: ${AZURE_CLIENT_ID:-}`, which sets an empty string on
    // every deployment that does not use a service principal.
    process.env.AZURE_TENANT_ID = TENANT;
    process.env.AZURE_CLIENT_ID = '';
    process.env.AZURE_CLIENT_SECRET = '';
    expect((await resolveAzureCredential()).source).toBe('chain');
  });

  it('needs a client id as well as a secret before it counts as configured', async () => {
    process.env.AZURE_TENANT_ID = TENANT;
    process.env.AZURE_CLIENT_SECRET = SECRET;
    expect((await resolveAzureCredential()).source).toBe('chain');
  });

  it('takes the tenant from the stored credential when the environment sets none', async () => {
    await saveAzureCredential({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET });
    expect((await resolveAzureCredential()).tenantId).toBe(TENANT);
  });

  it('throws a named, actionable error when nothing is configured at all', async () => {
    await expect(resolveAzureCredential()).rejects.toThrow(AzureNotConfiguredError);
    try {
      await resolveAzureCredential();
    } catch (err) {
      // The API layer lets this one message through to the browser (lib/api-error.ts), so it has to
      // say what to do and must not name a tenant or subscription.
      expect((err as Error).message).toMatch(/Settings/);
      expect((err as Error).message).not.toContain(TENANT);
    }
  });
});

describe('connection status', () => {
  it('reports nothing configured when nothing is', async () => {
    const status = await getAzureConnectionStatus();
    expect(status.configured).toBe(false);
    expect(status.source).toBeNull();
  });

  it('marks the connection as environment-managed so the UI can disable the form', async () => {
    process.env.AZURE_TENANT_ID = TENANT;
    process.env.AZURE_CLIENT_ID = CLIENT;
    process.env.AZURE_CLIENT_SECRET = SECRET;

    const status = await getAzureConnectionStatus();
    expect(status.managedByEnv).toBe(true);
    expect(status.configured).toBe(true);
    // Offering an editable field that resolution will ignore is worse than offering no field.
    expect(status.source).toBe('env-secret');
  });

  it('does not mark a stored credential as environment-managed', async () => {
    await saveAzureCredential({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET });
    const status = await getAzureConnectionStatus();
    expect(status.managedByEnv).toBe(false);
    expect(status.source).toBe('stored');
  });

  it('reports an unreadable stored secret as not configured, and says why', async () => {
    await saveAzureCredential({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET });
    const original = process.env.RULEBEAT_ENCRYPTION_KEY;
    try {
      process.env.RULEBEAT_ENCRYPTION_KEY = 'the-key-was-rotated-or-the-volume-replaced';
      resetSecretBoxForTests();

      const status = await getAzureConnectionStatus();
      expect(status.configured).toBe(false);
      expect(status.stored?.secretUnreadable).toBe(true);
      // "No data yet" and "this is broken for a specific reason" must not look the same.
      expect(status.message).toMatch(/encryption key/i);
    } finally {
      process.env.RULEBEAT_ENCRYPTION_KEY = original;
      resetSecretBoxForTests();
    }
  });

  it('falls back to the ambient chain when a stored secret cannot be read', async () => {
    await saveAzureCredential({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET });
    process.env.AZURE_TENANT_ID = TENANT;
    const original = process.env.RULEBEAT_ENCRYPTION_KEY;
    try {
      process.env.RULEBEAT_ENCRYPTION_KEY = 'a-different-key-again';
      resetSecretBoxForTests();
      // Handing the ciphertext to Azure would fail authentication with a baffling error; trying the
      // managed identity instead at least has a chance of working.
      expect((await resolveAzureCredential()).source).toBe('chain');
    } finally {
      process.env.RULEBEAT_ENCRYPTION_KEY = original;
      resetSecretBoxForTests();
    }
  });
});
