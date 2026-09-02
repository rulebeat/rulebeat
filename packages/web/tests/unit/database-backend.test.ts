/**
 * Backend selection (lib/db/backend.ts): the explicit RULEBEAT_DATABASE_BACKEND selector against
 * RULEBEAT_DATABASE_URL detection. The module decides at import time, so every case resets the
 * module registry and imports it fresh under its own environment, the same shape as
 * auth-url-mirror.test.ts. Nothing here opens a database: backend.ts only reads the environment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = [
  'RULEBEAT_DATABASE_URL',
  'RULEBEAT_DATABASE_URL_FILE',
  'RULEBEAT_DATABASE_BACKEND',
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  vi.resetModules();
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
});

const PG_URL = 'postgres://rulebeat:s3cret-P%40ss@db.example.internal:5433/rulebeat?sslmode=require';

async function load() {
  return import('@/lib/db/backend');
}

describe('backend selection', () => {
  it('an empty environment is SQLite, selected by nothing', async () => {
    const mod = await load();
    expect(mod.dbKind).toBe('sqlite');
    expect(mod.databaseUrl).toBeNull();
    expect(mod.describeBackend()).toEqual({ kind: 'sqlite', selectedBy: 'default' });
  });

  it('a connection string alone still selects Postgres, as before the selector existed', async () => {
    process.env.RULEBEAT_DATABASE_URL = PG_URL;
    const mod = await load();
    expect(mod.dbKind).toBe('pg');
    expect(mod.describeBackend().selectedBy).toBe('RULEBEAT_DATABASE_URL');
  });

  it('RULEBEAT_DATABASE_BACKEND=postgres with a connection string is Postgres, selected by the selector', async () => {
    process.env.RULEBEAT_DATABASE_BACKEND = 'postgres';
    process.env.RULEBEAT_DATABASE_URL = PG_URL;
    const mod = await load();
    expect(mod.dbKind).toBe('pg');
    expect(mod.describeBackend().selectedBy).toBe('RULEBEAT_DATABASE_BACKEND');
  });

  it('RULEBEAT_DATABASE_BACKEND=postgres with no connection string refuses to start instead of booting SQLite', async () => {
    process.env.RULEBEAT_DATABASE_BACKEND = 'postgres';
    await expect(load()).rejects.toThrow(/RULEBEAT_DATABASE_URL/);
    await expect(load()).rejects.toThrow(/will not fall back to a SQLite database/);
  });

  it('RULEBEAT_DATABASE_BACKEND=sqlite with a connection string is a contradiction and refuses to start', async () => {
    process.env.RULEBEAT_DATABASE_BACKEND = 'sqlite';
    process.env.RULEBEAT_DATABASE_URL = PG_URL;
    await expect(load()).rejects.toThrow(/contradict/);
  });

  it('RULEBEAT_DATABASE_BACKEND=sqlite alone is SQLite, selected by the selector', async () => {
    process.env.RULEBEAT_DATABASE_BACKEND = 'sqlite';
    const mod = await load();
    expect(mod.dbKind).toBe('sqlite');
    expect(mod.describeBackend()).toEqual({ kind: 'sqlite', selectedBy: 'RULEBEAT_DATABASE_BACKEND' });
  });

  it('accepts the selector case-insensitively with surrounding whitespace', async () => {
    process.env.RULEBEAT_DATABASE_BACKEND = '  Postgres ';
    process.env.RULEBEAT_DATABASE_URL = PG_URL;
    const mod = await load();
    expect(mod.dbKind).toBe('pg');
  });

  it('rejects a backend name it does not know, naming the two it does', async () => {
    process.env.RULEBEAT_DATABASE_BACKEND = 'mysql';
    await expect(load()).rejects.toThrow(/"postgres" or "sqlite"/);
  });
});

describe('describeBackend', () => {
  it('parses host, port, database and user out of the connection string and never the password', async () => {
    process.env.RULEBEAT_DATABASE_URL = PG_URL;
    const mod = await load();
    const info = mod.describeBackend();
    expect(info).toMatchObject({
      kind: 'postgres',
      host: 'db.example.internal',
      port: 5433,
      database: 'rulebeat',
      user: 'rulebeat',
    });
    const printed = JSON.stringify(info) + mod.formatBackend(info, null);
    expect(printed).not.toContain('s3cret');
    expect(printed).not.toContain('P%40ss');
    expect(printed).not.toContain('P@ss');
  });

  it('defaults the port to 5432 when the connection string omits it', async () => {
    process.env.RULEBEAT_DATABASE_URL = 'postgres://u:p@host/db';
    const mod = await load();
    expect(mod.describeBackend().port).toBe(5432);
  });
});

describe('formatBackend', () => {
  it('names the SQLite file and says nothing selected it when the URL is simply unset', async () => {
    const mod = await load();
    const line = mod.formatBackend(mod.describeBackend(), '/app/packages/web/data/rulebeat.db');
    expect(line).toBe('SQLite at /app/packages/web/data/rulebeat.db (nothing selected it: RULEBEAT_DATABASE_URL is unset)');
  });

  it('names host, port, database, user and the selector for Postgres', async () => {
    process.env.RULEBEAT_DATABASE_BACKEND = 'postgres';
    process.env.RULEBEAT_DATABASE_URL = PG_URL;
    const mod = await load();
    expect(mod.formatBackend(mod.describeBackend(), null))
      .toBe('PostgreSQL at db.example.internal:5433/rulebeat as rulebeat (selected by RULEBEAT_DATABASE_BACKEND)');
  });
});
