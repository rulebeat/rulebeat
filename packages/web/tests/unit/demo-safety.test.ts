/**
 * WS2g · demo mode's runtime kill switch.
 *
 * `await resolveAzureCredential()` (lib/azure-credential.ts) checks `await isDemoMode()` before anything else,
 * including before its own "environment always wins" resolution order — a demo deployment that
 * also happens to carry a real, fully-specified service principal in its environment must still
 * never be able to use it. This suite proves that ordering directly, rather than trusting the
 * comment: every test below hands the resolver a credential that would work if reached, and asserts
 * it never gets that far.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveAzureCredential,
  getAzureCredential,
  createTenantContext,
  AzureNotConfiguredError,
} from '@/lib/azure-credential';
import { stampDemoDatabase, resetDemoModeCacheForTests } from '@/lib/demo';
import { deleteMeta } from '@/lib/db/meta';

const STAMP_KEY = 'demo-mode-v1';
const ENV_KEYS = [
  'RULEBEAT_DEMO',
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_FEDERATED_TOKEN_FILE',
  'AZURE_CLIENT_CERTIFICATE_PATH',
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await deleteMeta(STAMP_KEY);
  resetDemoModeCacheForTests();
});

/** Turns on the full two-gate await isDemoMode(), the same way the generator does. */
async function enableDemoMode(): Promise<void> {
  process.env.RULEBEAT_DEMO = '1';
  await stampDemoDatabase();
  resetDemoModeCacheForTests();
}

describe('the kill switch beats a fully-specified environment credential', () => {
  it('await resolveAzureCredential() throws even with a valid client-secret env credential present', async () => {
    process.env.AZURE_TENANT_ID = '00000000-0000-0000-0000-000000000099';
    process.env.AZURE_CLIENT_ID = '00000000-0000-0000-0000-0000000000aa';
    process.env.AZURE_CLIENT_SECRET = 'not-a-real-secret';
    await enableDemoMode();

    await expect(resolveAzureCredential()).rejects.toThrow(AzureNotConfiguredError);
  });

  it('await resolveAzureCredential() throws even with a federated-identity env credential present', async () => {
    process.env.AZURE_TENANT_ID = '00000000-0000-0000-0000-000000000099';
    process.env.AZURE_CLIENT_ID = '00000000-0000-0000-0000-0000000000aa';
    process.env.AZURE_FEDERATED_TOKEN_FILE = '/var/run/secrets/azure/tokens/azure-identity-token';
    await enableDemoMode();

    await expect(resolveAzureCredential()).rejects.toThrow(AzureNotConfiguredError);
  });

  it('the thrown error names the demo instance, not the usual "not configured" message', async () => {
    await enableDemoMode();
    await expect(resolveAzureCredential()).rejects.toThrow(/demo instance/i);
  });

  it('await getAzureCredential(), the ARM-routes entry point, throws the same way', async () => {
    process.env.AZURE_TENANT_ID = '00000000-0000-0000-0000-000000000099';
    process.env.AZURE_CLIENT_ID = '00000000-0000-0000-0000-0000000000aa';
    process.env.AZURE_CLIENT_SECRET = 'not-a-real-secret';
    await enableDemoMode();

    await expect(getAzureCredential()).rejects.toThrow(AzureNotConfiguredError);
  });

  it('await createTenantContext(), the scan-pipeline entry point, rejects the same way', async () => {
    process.env.AZURE_TENANT_ID = '00000000-0000-0000-0000-000000000099';
    process.env.AZURE_CLIENT_ID = '00000000-0000-0000-0000-0000000000aa';
    process.env.AZURE_CLIENT_SECRET = 'not-a-real-secret';
    await enableDemoMode();

    await expect(createTenantContext()).rejects.toThrow(AzureNotConfiguredError);
  });
});

describe('an incomplete demo configuration does not accidentally trip the switch', () => {
  it('the env var alone, with no stamp, leaves real credential resolution untouched', async () => {
    process.env.AZURE_TENANT_ID = '00000000-0000-0000-0000-000000000099';
    process.env.AZURE_CLIENT_ID = '00000000-0000-0000-0000-0000000000aa';
    process.env.AZURE_CLIENT_SECRET = 'not-a-real-secret';
    process.env.RULEBEAT_DEMO = '1';
    resetDemoModeCacheForTests();
    // Deliberately no await stampDemoDatabase() call: await isDemoMode() is false here, same as WS2g's
    // demo-mode.test.ts truth table — this just re-confirms the credential resolver reads the same
    // gate rather than its own, weaker check of RULEBEAT_DEMO alone.
    const resolved = await resolveAzureCredential();
    expect(resolved.source).toBe('env-secret');
  });
});
