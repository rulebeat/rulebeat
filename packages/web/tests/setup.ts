/**
 * Runs before every web test file.
 *
 * Two jobs, both about making sure a test can never touch anything real:
 *  1. Point the SQLite singleton at a throwaway file *before* any repository module is imported.
 *     `lib/db/client.ts` opens its connection at import time, so this has to happen in a setup
 *     file — doing it inside a test would already be too late.
 *  2. Fill in the environment variables the app reads at module scope, so importing `auth.ts` or a
 *     route handler doesn't blow up on a missing value.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'rulebeat-test-'));

process.env.RULEBEAT_DB_PATH = join(dir, 'test.db');

// Backend selection (issue #73). A normal run must never inherit a developer's RULEBEAT_DATABASE_URL
// and silently test against their Postgres; only the test-specific RULEBEAT_TEST_PG_URL opts a run
// into the Postgres backend, and that run starts from an empty schema so `lib/db/client.ts`'s
// bootstrap recreates the tables fresh for every test file (vitest isolates module registries per
// file, so the import-time bootstrap re-runs each time).
// RULEBEAT_DATABASE_BACKEND is cleared in both branches for the same reason: the selector must
// come from this file's decision, never from the developer's shell.
delete process.env.RULEBEAT_DATABASE_BACKEND;
if (process.env.RULEBEAT_TEST_PG_URL) {
  process.env.RULEBEAT_DATABASE_URL = process.env.RULEBEAT_TEST_PG_URL;
  delete process.env.RULEBEAT_DATABASE_URL_FILE;
  const { Client } = await import('pg');
  const client = new Client({ connectionString: process.env.RULEBEAT_TEST_PG_URL });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
} else {
  delete process.env.RULEBEAT_DATABASE_URL;
  delete process.env.RULEBEAT_DATABASE_URL_FILE;
}
process.env.AZURE_TENANT_ID ??= '00000000-0000-0000-0000-000000000001';
process.env.AUTH_SECRET ??= 'test-secret-not-used-for-anything-real';
process.env.AUTH_URL ??= 'http://localhost:3000';
delete process.env.AUTH_SECRET_FILE;

// Deliberately NOT set here (unlike the Azure/db vars above): AUTH_MICROSOFT_ENTRA_ID_ID/_SECRET/
// _TENANT_ID drive `lib/sign-in-config.ts`'s env-vs-stored resolution order, so a suite testing
// that order needs to control them itself. Setting a global default here would make every such
// test see "env" unconditionally, regardless of what it's trying to exercise.
delete process.env.AUTH_MICROSOFT_ENTRA_ID_ID;
delete process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET;
delete process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID;
delete process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET_FILE;

// A test must never inherit the developer's own bootstrap admin or owner password.
delete process.env.RULEBEAT_INITIAL_ADMIN;
delete process.env.RULEBEAT_INITIAL_PASSWORD;
delete process.env.RULEBEAT_FORCE_LOCAL_SIGNIN;

// Nor their own Azure service principal. `lib/azure-credential.ts` resolves from the environment
// first, so leaving these set would make credential-resolution tests pass or fail depending on
// whose machine they run on — and, worse, would let a test reach real Azure.
delete process.env.AZURE_CLIENT_ID;
delete process.env.AZURE_CLIENT_SECRET;
delete process.env.AZURE_CLIENT_CERTIFICATE_PATH;
delete process.env.AZURE_FEDERATED_TOKEN_FILE;

// Nor their own default Log Analytics workspace (spec 035) — same reasoning as the Azure
// credential vars above.
delete process.env.RULEBEAT_LOG_ANALYTICS_WORKSPACE_ID;

// Nor demo mode. `await isDemoMode()` also requires a database stamp, but a suite that doesn't know to
// clean up its own RULEBEAT_DEMO=1 (or one that crashes before its afterEach runs) must not leak
// that into every test file that runs after it in the same process.
delete process.env.RULEBEAT_DEMO;

// Pin the encryption key so stored-secret tests are deterministic and never write a generated key
// file into the developer's data directory.
process.env.RULEBEAT_ENCRYPTION_KEY ??= 'test-encryption-key-not-used-for-anything-real';
delete process.env.RULEBEAT_ENCRYPTION_KEY_FILE;

afterAll(async () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can still hold the SQLite file handle as the process exits. A leftover temp
    // directory is harmless; failing the run over it would not be.
  }
});
