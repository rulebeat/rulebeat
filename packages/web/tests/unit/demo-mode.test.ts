/**
 * WS2g · demo mode's two-gate switch.
 *
 * `isDemoMode()` (lib/demo.ts) requires both `RULEBEAT_DEMO=1` (lib/demo-env.ts, gate 1) and the
 * `demo-mode-v1` stamp in the database's own `meta` table (gate 2, written only by the generator).
 * Neither gate is meaningful alone — the truth table below proves that directly, against the
 * ambient test database that `tests/setup.ts` already points at a throwaway file.
 *
 * The one thing that truth table *can't* prove is the file-routing decision in `lib/db/client.ts`:
 * `RULEBEAT_DB_PATH` (which `tests/setup.ts` always sets) deliberately beats the demo.db/rulebeat.db
 * choice, so within this process that choice is never actually exercised. Proving it needs the real
 * startup path in a process where `RULEBEAT_DB_PATH` is never set at all — the same reasoning
 * `tests/fixtures/upgrade.ts`'s `upgradeViaStartup()` documents for the migration path.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDemoEnv } from '@/lib/demo-env';
import { isDemoMode, stampDemoDatabase, resetDemoModeCacheForTests, DEMO_VISITOR_ID } from '@/lib/demo';
import { getMeta, deleteMeta } from '@/lib/db/meta';

const STAMP_KEY = 'demo-mode-v1';

afterEach(() => {
  delete process.env.RULEBEAT_DEMO;
  deleteMeta(STAMP_KEY);
  resetDemoModeCacheForTests();
});

describe('isDemoEnv() — gate 1, the environment variable in isolation', () => {
  it('is false when unset', () => {
    delete process.env.RULEBEAT_DEMO;
    expect(isDemoEnv()).toBe(false);
  });

  it('is false for anything other than the literal "1"', () => {
    process.env.RULEBEAT_DEMO = 'true';
    expect(isDemoEnv()).toBe(false);
  });

  it('is true for "1"', () => {
    process.env.RULEBEAT_DEMO = '1';
    expect(isDemoEnv()).toBe(true);
  });
});

describe('isDemoMode() — the two-gate truth table', () => {
  it('env unset, no stamp → false', () => {
    delete process.env.RULEBEAT_DEMO;
    resetDemoModeCacheForTests();
    expect(isDemoMode()).toBe(false);
  });

  it('env set, no stamp → false — the env var alone must not be enough', () => {
    process.env.RULEBEAT_DEMO = '1';
    resetDemoModeCacheForTests();
    expect(getMeta(STAMP_KEY)).toBeNull();
    expect(isDemoMode()).toBe(false);
  });

  it('stamp present, env unset → false — the stamp alone must not be enough', () => {
    stampDemoDatabase();
    delete process.env.RULEBEAT_DEMO;
    resetDemoModeCacheForTests();
    expect(isDemoMode()).toBe(false);
  });

  it('env set and stamped → true', () => {
    process.env.RULEBEAT_DEMO = '1';
    stampDemoDatabase();
    resetDemoModeCacheForTests();
    expect(isDemoMode()).toBe(true);
  });

  it('caches the stamp lookup until resetDemoModeCacheForTests() runs', () => {
    process.env.RULEBEAT_DEMO = '1';
    stampDemoDatabase();
    resetDemoModeCacheForTests();
    expect(isDemoMode()).toBe(true);

    deleteMeta(STAMP_KEY);
    // Nothing in the real app ever removes the stamp mid-process, so this isn't a real scenario —
    // it's here to pin the caching behaviour itself: the earlier `true` lookup stays cached.
    expect(isDemoMode()).toBe(true);

    resetDemoModeCacheForTests();
    expect(isDemoMode()).toBe(false);
  });
});

describe('DEMO_VISITOR_ID', () => {
  it('is the fixed id lib/api-auth.ts looks up for an anonymous demo visitor', () => {
    expect(DEMO_VISITOR_ID).toBe('demo-visitor');
  });
});

// ── Real startup path: proves lib/db/client.ts's file-routing decision ─────────────────────────

const WEB_ROOT = resolve(__dirname, '..', '..');
const REPO_ROOT = resolve(WEB_ROOT, '..', '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
// Reused from the upgrade suite's fixtures — its only job is `import '../../lib/db/client'`, which
// is exactly what's needed here too; nothing about it is upgrade-specific.
const RUNNER = join(WEB_ROOT, 'tests', 'fixtures', 'run-client-upgrade.ts');

function startRealClientIn(dir: string, env: Record<string, string>): { status: number | null; stderr: string } {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  // Deleted, not inherited: this test's whole point is letting client.ts make its own filename
  // decision, which RULEBEAT_DB_PATH would otherwise short-circuit (see this file's own comment).
  delete childEnv.RULEBEAT_DB_PATH;
  delete childEnv.VITEST;
  delete childEnv.RULEBEAT_INITIAL_ADMIN;

  const result = spawnSync(process.execPath, [TSX_CLI, RUNNER], {
    cwd: dir,
    encoding: 'utf8',
    env: childEnv,
  });
  return { status: result.status, stderr: result.stderr };
}

describe('lib/db/client.ts really does route to demo.db under RULEBEAT_DEMO=1', () => {
  it('opens data/rulebeat.db, never demo.db, when the env var is unset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rb-demo-client-'));
    const { status, stderr } = startRealClientIn(dir, {});
    expect(status, stderr).toBe(0);
    expect(existsSync(join(dir, 'data', 'rulebeat.db'))).toBe(true);
    expect(existsSync(join(dir, 'data', 'demo.db'))).toBe(false);
  }, 30_000);

  it('opens data/demo.db, never rulebeat.db, when RULEBEAT_DEMO=1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rb-demo-client-'));
    const { status, stderr } = startRealClientIn(dir, { RULEBEAT_DEMO: '1' });
    expect(status, stderr).toBe(0);
    expect(existsSync(join(dir, 'data', 'demo.db'))).toBe(true);
    expect(existsSync(join(dir, 'data', 'rulebeat.db'))).toBe(false);
  }, 30_000);
});
