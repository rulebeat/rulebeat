/**
 * next-auth reads the public URL from `process.env.AUTH_URL`, so a URL saved in Settings only has
 * an effect once it is mirrored there. The mirror used to be written only while the variable was
 * empty, which meant the second save and every clear were silently ignored until the next restart
 * while the Settings copy promised the change took effect immediately. Found by a Codex audit of
 * the metadataBase change that started reading the same variable.
 *
 * `OPERATOR_AUTH_URL` is captured when the module is first evaluated, so each case has to set the
 * environment and then import a fresh copy.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const original = process.env.AUTH_URL;

async function loadWithEnv(authUrl: string | undefined) {
  vi.resetModules();
  if (authUrl === undefined) delete process.env.AUTH_URL;
  else process.env.AUTH_URL = authUrl;
  return import('@/lib/sign-in-config');
}

afterEach(() => {
  if (original === undefined) delete process.env.AUTH_URL;
  else process.env.AUTH_URL = original;
});

describe('syncAuthUrlMirror', () => {
  it('mirrors a saved URL when the operator set no AUTH_URL', async () => {
    const { syncAuthUrlMirror } = await loadWithEnv(undefined);
    syncAuthUrlMirror('https://first.example.com');
    expect(process.env.AUTH_URL).toBe('https://first.example.com');
  });

  it('replaces an earlier saved URL instead of keeping the first one', async () => {
    const { syncAuthUrlMirror } = await loadWithEnv(undefined);
    syncAuthUrlMirror('https://first.example.com');
    syncAuthUrlMirror('https://second.example.com');
    expect(process.env.AUTH_URL).toBe('https://second.example.com');
  });

  it('unsets the variable when the setting is cleared', async () => {
    const { syncAuthUrlMirror } = await loadWithEnv(undefined);
    syncAuthUrlMirror('https://first.example.com');
    syncAuthUrlMirror(null);
    expect(process.env.AUTH_URL).toBeUndefined();
  });

  // The whole point of the operator capture: an IaC or Marketplace deployment arrives configured,
  // and nothing an admin does in the console may override it.
  it('never touches an AUTH_URL the operator set in the environment', async () => {
    const { syncAuthUrlMirror } = await loadWithEnv('https://operator.example.com');
    syncAuthUrlMirror('https://saved.example.com');
    expect(process.env.AUTH_URL).toBe('https://operator.example.com');
    syncAuthUrlMirror(null);
    expect(process.env.AUTH_URL).toBe('https://operator.example.com');
  });

  it('treats a whitespace-only AUTH_URL as unset, not as operator configuration', async () => {
    const { syncAuthUrlMirror } = await loadWithEnv('   ');
    syncAuthUrlMirror('https://saved.example.com');
    expect(process.env.AUTH_URL).toBe('https://saved.example.com');
  });
});
