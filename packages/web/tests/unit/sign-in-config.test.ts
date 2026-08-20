import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetDb } from '../helpers/db';
import { resetSecretBoxForTests } from '@/lib/secret-box';
import { createUser } from '@/lib/db/users';
import { setPassword, recordFailedAttempt } from '@/lib/db/local-accounts';
import { saveSsoProvider } from '@/lib/db/sso-providers';
import {
  authorizeLocalAccount, getLocalSignInPolicy, getSignInStatus, resolveSignInConfig,
  setLocalSignInPolicy,
} from '@/lib/sign-in-config';
import { hashPassword } from '@/lib/password';
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

beforeEach(() => {
  resetDb();
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
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
  it('resolves nothing when neither env nor a stored row exist', () => {
    expect(resolveSignInConfig()).toBeNull();
  });

  it('resolves the stored row when only it is set', () => {
    saveSsoProvider({
      provider: 'microsoft-entra-id',
      tenantId: '22222222-2222-2222-2222-222222222222',
      clientId: 'stored-client-id',
      clientSecret: 'stored-secret',
    });
    const resolved = resolveSignInConfig();
    expect(resolved?.source).toBe('stored');
    expect(resolved?.tenantId).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('resolves env when only env is set', () => {
    setEnvProvider();
    const resolved = resolveSignInConfig();
    expect(resolved?.source).toBe('env');
    expect(resolved?.tenantId).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('env wins even when a stored row also exists — a stored row never overrides env', () => {
    saveSsoProvider({
      provider: 'microsoft-entra-id',
      tenantId: '22222222-2222-2222-2222-222222222222',
      clientId: 'stored-client-id',
      clientSecret: 'stored-secret',
    });
    setEnvProvider();

    const resolved = resolveSignInConfig();
    expect(resolved?.source).toBe('env');
    expect(resolved?.tenantId).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('needs all three env vars — partial env does not count as configured', () => {
    process.env.AUTH_MICROSOFT_ENTRA_ID_ID = 'only-this-one';
    expect(resolveSignInConfig()).toBeNull();
  });

  // spec 023: AUTH_MICROSOFT_ENTRA_ID_SECRET_FILE — a mounted-secret path, same precedence as
  // AZURE_CLIENT_SECRET_FILE / AUTH_SECRET_FILE / RULEBEAT_ENCRYPTION_KEY_FILE.
  it('AUTH_MICROSOFT_ENTRA_ID_SECRET_FILE wins over a simultaneously-set _SECRET', () => {
    process.env.AUTH_MICROSOFT_ENTRA_ID_ID = 'env-client-id';
    process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID = '11111111-1111-1111-1111-111111111111';
    process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET = 'the-plain-env-secret';
    process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET_FILE = secretFile('from-the-mounted-file\n');

    const resolved = resolveSignInConfig();
    expect(resolved?.source).toBe('env');
    expect(resolved?.clientSecret).toBe('from-the-mounted-file');
  });

  it('resolves env from the secret file alone, trimmed', () => {
    process.env.AUTH_MICROSOFT_ENTRA_ID_ID = 'env-client-id';
    process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID = '11111111-1111-1111-1111-111111111111';
    process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET_FILE = secretFile('  from-the-mounted-file  \n');

    const resolved = resolveSignInConfig();
    expect(resolved?.source).toBe('env');
    expect(resolved?.clientSecret).toBe('from-the-mounted-file');
  });

  it('never reads the secret file when the tenant/client id are not configured', () => {
    // IDs are checked before the secret is resolved (mirrors azure-credential.ts's
    // envCredentialSource) — an unrelated _FILE var left set on this host must not be read, and
    // must not throw, when Entra sign-in isn't otherwise configured.
    process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET_FILE = '/nonexistent/path/should-never-be-opened';
    expect(resolveSignInConfig()).toBeNull();
  });
});

describe('getSignInStatus', () => {
  it('managedByEnv is true only when env fully resolves', () => {
    expect(getSignInStatus().managedByEnv).toBe(false);
    setEnvProvider();
    expect(getSignInStatus().managedByEnv).toBe(true);
  });

  it('a stored-but-unverified row reports configured but not active', () => {
    saveSsoProvider({
      provider: 'microsoft-entra-id',
      tenantId: '22222222-2222-2222-2222-222222222222',
      clientId: 'stored-client-id',
      clientSecret: 'stored-secret',
    });
    const status = getSignInStatus();
    expect(status.configured).toBe(true);
    expect(status.isActive).toBe(false);
  });

  it('env-managed config reports active immediately (the operator vouches for it)', () => {
    setEnvProvider();
    expect(getSignInStatus().isActive).toBe(true);
  });

  it('the summary never carries a secret field', () => {
    saveSsoProvider({
      provider: 'microsoft-entra-id',
      tenantId: '22222222-2222-2222-2222-222222222222',
      clientId: 'stored-client-id',
      clientSecret: 'stored-secret',
    });
    const status = getSignInStatus();
    expect(Object.keys(status.stored ?? {})).not.toContain('clientSecret');
    expect(JSON.stringify(status)).not.toContain('stored-secret');
  });

  it('an unreadable stored secret degrades to secretUnreadable, not a crash', () => {
    saveSsoProvider({
      provider: 'microsoft-entra-id',
      tenantId: '22222222-2222-2222-2222-222222222222',
      clientId: 'stored-client-id',
      clientSecret: 'stored-secret',
    });

    const original = process.env.RULEBEAT_ENCRYPTION_KEY;
    try {
      process.env.RULEBEAT_ENCRYPTION_KEY = 'a-totally-different-key';
      resetSecretBoxForTests();

      const status = getSignInStatus();
      expect(status.configured).toBe(false);
      expect(status.stored?.secretUnreadable).toBe(true);
    } finally {
      process.env.RULEBEAT_ENCRYPTION_KEY = original;
      resetSecretBoxForTests();
    }
  });
});

describe('local sign-in policy guard (the lockout risk)', () => {
  it('defaults to always', () => {
    expect(getLocalSignInPolicy()).toBe('always');
  });

  it('round-trips through setLocalSignInPolicy', () => {
    setLocalSignInPolicy('break-glass');
    expect(getLocalSignInPolicy()).toBe('break-glass');
  });

  // The guard itself lives in the API route (it needs to return a 409 with a specific message),
  // not in this module — this suite just proves the ingredient the guard depends on, countAdmins-
  // WithPassword, tells the truth, since that's what the route checks against.
  it('countAdminsWithPassword is 0 until an admin actually gets a local password', async () => {
    const { countAdminsWithPassword } = await import('@/lib/db/local-accounts');
    expect(countAdminsWithPassword()).toBe(0);

    const admin = createUser({ email: 'admin@example.com', role: 'admin' });
    if ('error' in admin) throw new Error(admin.error);
    expect(countAdminsWithPassword()).toBe(0);

    setPassword(admin.user.id, 'some-hash', { mustChangePassword: false });
    expect(countAdminsWithPassword()).toBe(1);
  });
});

describe('local sign-in policy enforcement inside authorizeLocalAccount', () => {
  it('a disabled policy refuses local sign-in even with correct credentials', async () => {
    const created = createUser({ email: 'forced-out@example.com', role: 'admin' });
    if ('error' in created) throw new Error(created.error);
    setPassword(created.user.id, await hashPassword('CorrectPassword1!'), { mustChangePassword: false });
    setLocalSignInPolicy('disabled');

    const result = await authorizeLocalAccount({ email: 'forced-out@example.com', password: 'CorrectPassword1!' });
    expect(result).toBeNull();
  });

  it('RULEBEAT_FORCE_LOCAL_SIGNIN re-enables it under a disabled policy', async () => {
    const created = createUser({ email: 'escape-hatch@example.com', role: 'admin' });
    if ('error' in created) throw new Error(created.error);
    setPassword(created.user.id, await hashPassword('CorrectPassword1!'), { mustChangePassword: false });
    setLocalSignInPolicy('disabled');

    process.env.RULEBEAT_FORCE_LOCAL_SIGNIN = 'true';
    try {
      const result = await authorizeLocalAccount({ email: 'escape-hatch@example.com', password: 'CorrectPassword1!' });
      expect(result).not.toBeNull();
    } finally {
      delete process.env.RULEBEAT_FORCE_LOCAL_SIGNIN;
    }
  });

  it('break-glass and always both permit sign-in normally', async () => {
    const created = createUser({ email: 'normal@example.com', role: 'viewer' });
    if ('error' in created) throw new Error(created.error);
    setPassword(created.user.id, await hashPassword('CorrectPassword1!'), { mustChangePassword: false });

    for (const policy of ['always', 'break-glass'] as const) {
      setLocalSignInPolicy(policy);
      const result = await authorizeLocalAccount({ email: 'normal@example.com', password: 'CorrectPassword1!' });
      expect(result).not.toBeNull();
    }
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

      expect(listAuditEntries()).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('a real user with no local password (SSO-only) on the local form is logged, not persisted', async () => {
    const created = createUser({ email: 'sso-only@example.com', role: 'viewer', oid: 'oid-sso-only' });
    if ('error' in created) throw new Error(created.error);
    // Deliberately no setPassword() call — this account only ever signs in via Entra.

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await authorizeLocalAccount({ email: 'sso-only@example.com', password: 'AnythingAtAll1!' });
      expect(result).toBeNull();

      expect(logSpy).toHaveBeenCalled();
      const payload = JSON.parse(logSpy.mock.calls[0]![0] as string);
      expect(payload.reason).toBe('unknown-account');

      expect(listAuditEntries()).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('a repeated request against an already-locked-out account is logged, not persisted as another row', async () => {
    const created = createUser({ email: 'lockout-flood@example.com', role: 'viewer' });
    if ('error' in created) throw new Error(created.error);
    setPassword(created.user.id, await hashPassword('CorrectPassword1!'), { mustChangePassword: false });

    // Cause the lockout directly rather than via 5 real requests — isLockedOut()'s threshold is
    // MAX_FAILED_ATTEMPTS (5), and this is only testing what happens once that state is reached.
    for (let i = 0; i < 5; i++) recordFailedAttempt(created.user.id);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await authorizeLocalAccount({ email: 'lockout-flood@example.com', password: 'CorrectPassword1!' });
      expect(result).toBeNull();

      expect(logSpy).toHaveBeenCalled();
      const payload = JSON.parse(logSpy.mock.calls[0]![0] as string);
      expect(payload.message).toContain('locked out');

      // No wrong-password audit row either — isLockedOut() short-circuits before verifyPassword runs.
      expect(listAuditEntries()).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('a real user entering the wrong password (not locked out) still writes an audit row — unchanged', async () => {
    const created = createUser({ email: 'wrongpw@example.com', role: 'viewer' });
    if ('error' in created) throw new Error(created.error);
    setPassword(created.user.id, await hashPassword('CorrectPassword1!'), { mustChangePassword: false });

    const result = await authorizeLocalAccount({ email: 'wrongpw@example.com', password: 'TotallyWrong1!' });
    expect(result).toBeNull();

    const entries = listAuditEntries();
    expect(entries.some(e =>
      e.action === 'auth.sign_in_failed' && e.actorEmail === 'wrongpw@example.com',
    )).toBe(true);
  });
});
