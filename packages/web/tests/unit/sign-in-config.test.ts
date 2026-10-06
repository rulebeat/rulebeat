import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetDb } from '../helpers/db';
import { resetSecretBoxForTests } from '@/lib/secret-box';
import { createUser, getUser } from '@/lib/db/users';
import { setPassword, recordFailedAttempt, getLocalAccount, isLockedOut } from '@/lib/db/local-accounts';
import * as localAccountsModule from '@/lib/db/local-accounts';
import { saveSsoProvider } from '@/lib/db/sso-providers';
import {
  authorizeLocalAccount, getLocalSignInPolicy, getSignInStatus, resolveSignInConfig,
  setLocalSignInPolicy, SignInBusyError,
} from '@/lib/sign-in-config';
import {
  getDummyVerificationCallCountForTests, getRealVerificationCallCountForTests, hashPassword,
  isPasswordGateSaturated, resetDummyVerificationCallCountForTests,
  resetPasswordGateForTests, resetRealVerificationCallCountForTests, setPasswordGateLimitsForTests,
  withPasswordGate,
} from '@/lib/password';
import { MAX_SIGNIN_PASSWORD_LENGTH } from '@/lib/password-policy';
import { listAuditEntries } from '@/lib/db/audit';

const ENV_KEYS = [
  'AUTH_MICROSOFT_ENTRA_ID_ID',
  'AUTH_MICROSOFT_ENTRA_ID_SECRET',
  'AUTH_MICROSOFT_ENTRA_ID_SECRET_FILE',
  'AUTH_MICROSOFT_ENTRA_ID_TENANT_ID',
] as const;
const originalEnv: Record<string, string | undefined> = {};

/** Writes `contents` to a throwaway file and returns its path — stands in for a mounted secret. */
function secretFile(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'rulebeat-sso-secret-')), 'entra_client_secret');
  writeFileSync(path, contents);
  return path;
}

beforeEach(async () => {
  await resetDb();
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

function setEnvProvider() {
  process.env.AUTH_MICROSOFT_ENTRA_ID_ID = 'env-client-id';
  process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET = 'env-client-secret';
  process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID = '11111111-1111-1111-1111-111111111111';
}

describe('resolveSignInConfig', () => {
  it('resolves nothing when neither env nor a stored row exist', async () => {
    expect(await resolveSignInConfig()).toBeNull();
  });

  it('resolves the stored row when only it is set', async () => {
    await saveSsoProvider({
      provider: 'microsoft-entra-id',
      tenantId: '22222222-2222-2222-2222-222222222222',
      clientId: 'stored-client-id',
      clientSecret: 'stored-secret',
    });
    const resolved = await resolveSignInConfig();
    expect(resolved?.source).toBe('stored');
    expect(resolved?.tenantId).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('resolves env when only env is set', async () => {
    setEnvProvider();
    const resolved = await resolveSignInConfig();
    expect(resolved?.source).toBe('env');
    expect(resolved?.tenantId).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('env wins even when a stored row also exists — a stored row never overrides env', async () => {
    await saveSsoProvider({
      provider: 'microsoft-entra-id',
      tenantId: '22222222-2222-2222-2222-222222222222',
      clientId: 'stored-client-id',
      clientSecret: 'stored-secret',
    });
    setEnvProvider();

    const resolved = await resolveSignInConfig();
    expect(resolved?.source).toBe('env');
    expect(resolved?.tenantId).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('needs all three env vars — partial env does not count as configured', async () => {
    process.env.AUTH_MICROSOFT_ENTRA_ID_ID = 'only-this-one';
    expect(await resolveSignInConfig()).toBeNull();
  });

  // spec 023: AUTH_MICROSOFT_ENTRA_ID_SECRET_FILE — a mounted-secret path, same precedence as
  // AZURE_CLIENT_SECRET_FILE / AUTH_SECRET_FILE / RULEBEAT_ENCRYPTION_KEY_FILE.
  it('AUTH_MICROSOFT_ENTRA_ID_SECRET_FILE wins over a simultaneously-set _SECRET', async () => {
    process.env.AUTH_MICROSOFT_ENTRA_ID_ID = 'env-client-id';
    process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID = '11111111-1111-1111-1111-111111111111';
    process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET = 'the-plain-env-secret';
    process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET_FILE = secretFile('from-the-mounted-file\n');

    const resolved = await resolveSignInConfig();
    expect(resolved?.source).toBe('env');
    expect(resolved?.clientSecret).toBe('from-the-mounted-file');
  });

  it('resolves env from the secret file alone, trimmed', async () => {
    process.env.AUTH_MICROSOFT_ENTRA_ID_ID = 'env-client-id';
    process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID = '11111111-1111-1111-1111-111111111111';
    process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET_FILE = secretFile('  from-the-mounted-file  \n');

    const resolved = await resolveSignInConfig();
    expect(resolved?.source).toBe('env');
    expect(resolved?.clientSecret).toBe('from-the-mounted-file');
  });

  it('never reads the secret file when the tenant/client id are not configured', async () => {
    // IDs are checked before the secret is resolved (mirrors azure-credential.ts's
    // envCredentialSource) — an unrelated _FILE var left set on this host must not be read, and
    // must not throw, when Entra sign-in isn't otherwise configured.
    process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET_FILE = '/nonexistent/path/should-never-be-opened';
    expect(await resolveSignInConfig()).toBeNull();
  });
});

describe('getSignInStatus', () => {
  it('managedByEnv is true only when env fully resolves', async () => {
    expect((await getSignInStatus()).managedByEnv).toBe(false);
    setEnvProvider();
    expect((await getSignInStatus()).managedByEnv).toBe(true);
  });

  it('a stored-but-unverified row reports configured but not active', async () => {
    await saveSsoProvider({
      provider: 'microsoft-entra-id',
      tenantId: '22222222-2222-2222-2222-222222222222',
      clientId: 'stored-client-id',
      clientSecret: 'stored-secret',
    });
    const status = await getSignInStatus();
    expect(status.configured).toBe(true);
    expect(status.isActive).toBe(false);
  });

  it('env-managed config reports active immediately (the operator vouches for it)', async () => {
    setEnvProvider();
    expect((await getSignInStatus()).isActive).toBe(true);
  });

  it('the summary never carries a secret field', async () => {
    await saveSsoProvider({
      provider: 'microsoft-entra-id',
      tenantId: '22222222-2222-2222-2222-222222222222',
      clientId: 'stored-client-id',
      clientSecret: 'stored-secret',
    });
    const status = await getSignInStatus();
    expect(Object.keys(status.stored ?? {})).not.toContain('clientSecret');
    expect(JSON.stringify(status)).not.toContain('stored-secret');
  });

  it('an unreadable stored secret degrades to secretUnreadable, not a crash', async () => {
    await saveSsoProvider({
      provider: 'microsoft-entra-id',
      tenantId: '22222222-2222-2222-2222-222222222222',
      clientId: 'stored-client-id',
      clientSecret: 'stored-secret',
    });

    const original = process.env.RULEBEAT_ENCRYPTION_KEY;
    try {
      process.env.RULEBEAT_ENCRYPTION_KEY = 'a-totally-different-key';
      resetSecretBoxForTests();

      const status = await getSignInStatus();
      expect(status.configured).toBe(false);
      expect(status.stored?.secretUnreadable).toBe(true);
    } finally {
      process.env.RULEBEAT_ENCRYPTION_KEY = original;
      resetSecretBoxForTests();
    }
  });
});

describe('local sign-in policy guard (the lockout risk)', () => {
  it('defaults to always', async () => {
    expect(await getLocalSignInPolicy()).toBe('always');
  });

  it('round-trips through setLocalSignInPolicy', async () => {
    await setLocalSignInPolicy('break-glass');
    expect(await getLocalSignInPolicy()).toBe('break-glass');
  });

  // The guard itself lives in the API route (it needs to return a 409 with a specific message),
  // not in this module — this suite just proves the ingredient the guard depends on, countAdmins-
  // WithPassword, tells the truth, since that's what the route checks against.
  it('countAdminsWithPassword is 0 until an admin actually gets a local password', async () => {
    const { countAdminsWithPassword } = await import('@/lib/db/local-accounts');
    expect(await countAdminsWithPassword()).toBe(0);

    const admin = await createUser({ email: 'admin@example.com', role: 'admin' });
    if ('error' in admin) throw new Error(admin.error);
    expect(await countAdminsWithPassword()).toBe(0);

    await setPassword(admin.user.id, 'some-hash', { mustChangePassword: false });
    expect(await countAdminsWithPassword()).toBe(1);
  });
});

describe('local sign-in policy enforcement inside authorizeLocalAccount', () => {
  it('a disabled policy refuses local sign-in even with correct credentials', async () => {
    const created = await createUser({ email: 'forced-out@example.com', role: 'admin' });
    if ('error' in created) throw new Error(created.error);
    await setPassword(created.user.id, await hashPassword('CorrectPassword1!'), { mustChangePassword: false });
    await setLocalSignInPolicy('disabled');

    const result = await authorizeLocalAccount({ email: 'forced-out@example.com', password: 'CorrectPassword1!' });
    expect(result).toBeNull();
  });

  it('RULEBEAT_FORCE_LOCAL_SIGNIN re-enables it under a disabled policy', async () => {
    const created = await createUser({ email: 'escape-hatch@example.com', role: 'admin' });
    if ('error' in created) throw new Error(created.error);
    await setPassword(created.user.id, await hashPassword('CorrectPassword1!'), { mustChangePassword: false });
    await setLocalSignInPolicy('disabled');

    process.env.RULEBEAT_FORCE_LOCAL_SIGNIN = 'true';
    try {
      const result = await authorizeLocalAccount({ email: 'escape-hatch@example.com', password: 'CorrectPassword1!' });
      expect(result).not.toBeNull();
    } finally {
      delete process.env.RULEBEAT_FORCE_LOCAL_SIGNIN;
    }
  });

  it('break-glass and always both permit sign-in normally', async () => {
    const created = await createUser({ email: 'normal@example.com', role: 'viewer' });
    if ('error' in created) throw new Error(created.error);
    await setPassword(created.user.id, await hashPassword('CorrectPassword1!'), { mustChangePassword: false });

    for (const policy of ['always', 'break-glass'] as const) {
      await setLocalSignInPolicy(policy);
      const result = await authorizeLocalAccount({ email: 'normal@example.com', password: 'CorrectPassword1!' });
      expect(result).not.toBeNull();
    }
  });

  // Settings → Users reads lastSeenAt to decide between "Never signed in" and a real timestamp.
  // The Entra path updates it via await provisionUser()'s await touchLastSeen() call; a successful local
  // sign-in must do the same, or a local admin who signs in every day still shows as never
  // having signed in.
  it('a successful local sign-in sets lastSeenAt, same as the Entra path', async () => {
    const created = await createUser({ email: 'lastseen@example.com', role: 'viewer' });
    if ('error' in created) throw new Error(created.error);
    expect(created.user.lastSeenAt).toBeNull();
    await setPassword(created.user.id, await hashPassword('CorrectPassword1!'), { mustChangePassword: false });

    const result = await authorizeLocalAccount({ email: 'lastseen@example.com', password: 'CorrectPassword1!' });
    expect(result).not.toBeNull();

    expect((await getUser(created.user.id))?.lastSeenAt).not.toBeNull();
  });
});

describe('flood-vector logging inside authorizeLocalAccount (spec 022)', () => {
  it('a nonexistent email is logged, not persisted', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await authorizeLocalAccount({ email: 'nobody@example.com', password: 'Whatever123!' });
      expect(result).toBeNull();

      expect(logSpy).toHaveBeenCalled();
      const payload = JSON.parse(logSpy.mock.calls[0]![0] as string);
      expect(payload.reason).toBe('unknown-account');

      expect(await listAuditEntries()).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('a real user with no local password (SSO-only) on the local form is logged, not persisted', async () => {
    const created = await createUser({ email: 'sso-only@example.com', role: 'viewer', oid: 'oid-sso-only' });
    if ('error' in created) throw new Error(created.error);
    // Deliberately no await setPassword() call — this account only ever signs in via Entra.

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await authorizeLocalAccount({ email: 'sso-only@example.com', password: 'AnythingAtAll1!' });
      expect(result).toBeNull();

      expect(logSpy).toHaveBeenCalled();
      const payload = JSON.parse(logSpy.mock.calls[0]![0] as string);
      expect(payload.reason).toBe('unknown-account');

      expect(await listAuditEntries()).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('a repeated request against an already-locked-out account is logged, not persisted as another row', async () => {
    const created = await createUser({ email: 'lockout-flood@example.com', role: 'viewer' });
    if ('error' in created) throw new Error(created.error);
    await setPassword(created.user.id, await hashPassword('CorrectPassword1!'), { mustChangePassword: false });

    // Cause the lockout directly rather than via 5 real requests — isLockedOut()'s threshold is
    // MAX_FAILED_ATTEMPTS (5), and this is only testing what happens once that state is reached.
    for (let i = 0; i < 5; i++) await recordFailedAttempt(created.user.id);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await authorizeLocalAccount({ email: 'lockout-flood@example.com', password: 'CorrectPassword1!' });
      expect(result).toBeNull();

      expect(logSpy).toHaveBeenCalled();
      const payload = JSON.parse(logSpy.mock.calls[0]![0] as string);
      expect(payload.message).toContain('locked out');

      // No wrong-password audit row either — isLockedOut() short-circuits before verifyPassword runs.
      expect(await listAuditEntries()).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('a real user entering the wrong password (not locked out) still writes an audit row — unchanged', async () => {
    const created = await createUser({ email: 'wrongpw@example.com', role: 'viewer' });
    if ('error' in created) throw new Error(created.error);
    await setPassword(created.user.id, await hashPassword('CorrectPassword1!'), { mustChangePassword: false });

    const result = await authorizeLocalAccount({ email: 'wrongpw@example.com', password: 'TotallyWrong1!' });
    expect(result).toBeNull();

    const entries = await listAuditEntries();
    expect(entries.some(e =>
      e.action === 'auth.sign_in_failed' && e.actorEmail === 'wrongpw@example.com',
    )).toBe(true);
  });
});

describe('authorizeLocalAccount under a saturated password gate', () => {
  afterEach(() => {
    resetPasswordGateForTests();
  });

  it('throws SignInBusyError without a DB write, a password claim, or any hashing', async () => {
    const created = await createUser({ email: 'busy@example.com', role: 'viewer' });
    if ('error' in created) throw new Error(created.error);
    await setPassword(created.user.id, await hashPassword('CorrectPassword1!'), { mustChangePassword: false });

    setPasswordGateLimitsForTests(1, 0);
    // Occupy the single slot forever so the gate reads as saturated for the rest of this test.
    void withPasswordGate(() => new Promise<void>(() => {}));
    expect(isPasswordGateSaturated()).toBe(true);

    resetDummyVerificationCallCountForTests();
    resetRealVerificationCallCountForTests();

    let caught: unknown;
    try {
      await authorizeLocalAccount({ email: 'busy@example.com', password: 'CorrectPassword1!' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SignInBusyError);
    expect((caught as SignInBusyError).code).toBe('busy');

    // Nothing was spent reaching this rejection: no claim, no real or dummy scrypt call, no audit.
    expect(getDummyVerificationCallCountForTests()).toBe(0);
    expect(getRealVerificationCallCountForTests()).toBe(0);
    expect((await getLocalAccount(created.user.id))!.failedAttempts).toBe(0);
    expect(await listAuditEntries()).toHaveLength(0);
  });

  it('gives the attempt back when the gate fills after the attempt was claimed', async () => {
    const created = await createUser({ email: 'busy-late@example.com', role: 'viewer' });
    if ('error' in created) throw new Error(created.error);
    await setPassword(created.user.id, await hashPassword('CorrectPassword1!'), { mustChangePassword: false });
    // Four real failures, so the claim on the next attempt is the one that sets the lock.
    for (let i = 0; i < 4; i++) await recordFailedAttempt(created.user.id);

    setPasswordGateLimitsForTests(1, 0);
    const realClaim = localAccountsModule.claimFailedAttempt;
    const spy = vi.spyOn(localAccountsModule, 'claimFailedAttempt').mockImplementation(async (userId) => {
      const result = await realClaim(userId);
      void withPasswordGate(() => new Promise<void>(() => {}));
      return result;
    });

    try {
      await expect(
        authorizeLocalAccount({ email: 'busy-late@example.com', password: 'CorrectPassword1!' }),
      ).rejects.toBeInstanceOf(SignInBusyError);
    } finally {
      spy.mockRestore();
    }

    const account = (await getLocalAccount(created.user.id))!;
    expect(account.failedAttempts).toBe(4);
    expect(isLockedOut(account)).toBe(false);
  });
});

describe('the locked-account branch burns a dummy verification too (closing the timing oracle)', () => {
  it('calls verifyDummyPassword before returning null for a locked-out account', async () => {
    const created = await createUser({ email: 'locked-dummy@example.com', role: 'viewer' });
    if ('error' in created) throw new Error(created.error);
    await setPassword(created.user.id, await hashPassword('CorrectPassword1!'), { mustChangePassword: false });
    for (let i = 0; i < 5; i++) await recordFailedAttempt(created.user.id);

    const before = getDummyVerificationCallCountForTests();
    const result = await authorizeLocalAccount({ email: 'locked-dummy@example.com', password: 'CorrectPassword1!' });

    expect(result).toBeNull();
    expect(getDummyVerificationCallCountForTests()).toBe(before + 1);
  });
});

describe('oversized sign-in passwords are rejected before any hashing', () => {
  it('returns null without ever reaching verifyPassword for a password over the limit', async () => {
    const created = await createUser({ email: 'oversized@example.com', role: 'viewer' });
    if ('error' in created) throw new Error(created.error);
    await setPassword(created.user.id, await hashPassword('CorrectPassword1!'), { mustChangePassword: false });

    resetRealVerificationCallCountForTests();
    resetDummyVerificationCallCountForTests();

    const oversized = 'a'.repeat(MAX_SIGNIN_PASSWORD_LENGTH + 1);
    const result = await authorizeLocalAccount({ email: 'oversized@example.com', password: oversized });

    expect(result).toBeNull();
    expect(getRealVerificationCallCountForTests()).toBe(0);
    expect(getDummyVerificationCallCountForTests()).toBe(0);
  });

  it('still accepts a password exactly at the limit', async () => {
    const created = await createUser({ email: 'at-limit@example.com', role: 'viewer' });
    if ('error' in created) throw new Error(created.error);
    const atLimit = 'Cx1!' + 'a'.repeat(MAX_SIGNIN_PASSWORD_LENGTH - 4);
    await setPassword(created.user.id, await hashPassword(atLimit), { mustChangePassword: false });

    const result = await authorizeLocalAccount({ email: 'at-limit@example.com', password: atLimit });
    expect(result).not.toBeNull();
  });
});

describe('concurrent wrong guesses never exceed the failed-attempt cap (the lockout race)', () => {
  it('N concurrent wrong-password attempts against one account cap out at 5 failed attempts', async () => {
    const created = await createUser({ email: 'race@example.com', role: 'viewer' });
    if ('error' in created) throw new Error(created.error);
    await setPassword(created.user.id, await hashPassword('CorrectPassword1!'), { mustChangePassword: false });

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        authorizeLocalAccount({ email: 'race@example.com', password: 'WrongPassword1!' })),
    );
    expect(results.every(r => r === null)).toBe(true);

    const account = (await getLocalAccount(created.user.id))!;
    expect(account.failedAttempts).toBe(5);
    expect(isLockedOut(account)).toBe(true);
  });

  it('a correct password on the 5th attempt still signs in, even after 4 prior failures', async () => {
    const created = await createUser({ email: 'fifth-correct@example.com', role: 'viewer' });
    if ('error' in created) throw new Error(created.error);
    await setPassword(created.user.id, await hashPassword('CorrectPassword1!'), { mustChangePassword: false });

    for (let i = 0; i < 4; i++) {
      const attempt = await authorizeLocalAccount({ email: 'fifth-correct@example.com', password: 'WrongPassword1!' });
      expect(attempt).toBeNull();
    }

    const result = await authorizeLocalAccount({ email: 'fifth-correct@example.com', password: 'CorrectPassword1!' });
    expect(result).not.toBeNull();

    const account = (await getLocalAccount(created.user.id))!;
    expect(account.failedAttempts).toBe(0);
    expect(isLockedOut(account)).toBe(false);
  });
});
