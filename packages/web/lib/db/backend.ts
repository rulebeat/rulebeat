import { readFileSync } from 'fs';

/**
 * Which database backend this process runs against, decided once at first import.
 *
 * Two variables take part:
 *
 * - `RULEBEAT_DATABASE_URL` (or `RULEBEAT_DATABASE_URL_FILE`, the Docker/Compose secret variant,
 *   same convention as `AUTH_SECRET_FILE`). Unset means SQLite, exactly as every install before
 *   this setting existed; a postgres:// connection string means Postgres.
 * - `RULEBEAT_DATABASE_BACKEND`, `sqlite` or `postgres`, which names the backend on purpose.
 *   It exists because "the URL is missing" and "I chose SQLite" are indistinguishable to URL
 *   detection alone: a Container Apps deployment whose connection string never made it onto the
 *   running revision booted a SQLite database inside the container, worked, and lost everything on
 *   the first restart. With `postgres` set, an empty URL is a startup failure with the reason in
 *   the log rather than a silent fallback; with `sqlite` set, a URL is a contradiction and also
 *   fails. Unset keeps URL detection, so an empty environment still boots SQLite and the Docker
 *   quick start is unchanged.
 *
 * Deliberately the `RULEBEAT_`-prefixed names rather than bare `DATABASE_URL`: platforms inject
 * `DATABASE_URL` for databases that have nothing to do with RuleBeat, and an unrelated injected
 * value silently flipping the backend would violate "empty env = SQLite, explicit opt-in".
 *
 * Reads are literal `process.env.NAME` lookups, never dynamic, for the same bundler-inlining
 * reason documented in `lib/auth-secret.ts`.
 */

type UrlSource = 'RULEBEAT_DATABASE_URL' | 'RULEBEAT_DATABASE_URL_FILE';

function resolveDatabaseUrl(): { url: string; source: UrlSource } | null {
  const direct = process.env.RULEBEAT_DATABASE_URL?.trim();
  if (direct) return { url: direct, source: 'RULEBEAT_DATABASE_URL' };

  const file = process.env.RULEBEAT_DATABASE_URL_FILE?.trim();
  if (file) {
    // An unreadable secret file throws rather than falling back to SQLite: a misconfigured
    // Postgres deployment must fail loudly, not silently boot an empty SQLite database.
    const fromFile = readFileSync(file, 'utf8').trim();
    if (fromFile) return { url: fromFile, source: 'RULEBEAT_DATABASE_URL_FILE' };
  }

  return null;
}

export type DbBackendName = 'sqlite' | 'postgres';

function resolveRequestedBackend(): DbBackendName | null {
  const raw = process.env.RULEBEAT_DATABASE_BACKEND?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'sqlite' || raw === 'postgres') return raw;
  throw new Error(
    `RULEBEAT_DATABASE_BACKEND is "${raw}", which is not a backend RuleBeat knows. `
    + 'Set it to "postgres" or "sqlite", or leave it unset to select by RULEBEAT_DATABASE_URL.',
  );
}

const resolvedUrl = resolveDatabaseUrl();
const requestedBackend = resolveRequestedBackend();

export const databaseUrl: string | null = resolvedUrl?.url ?? null;

if (databaseUrl && !/^postgres(ql)?:\/\//i.test(databaseUrl)) {
  throw new Error(
    'RULEBEAT_DATABASE_URL must be a postgres:// or postgresql:// connection string. '
    + 'Leave it unset to use the built-in SQLite database.',
  );
}

if (requestedBackend === 'postgres' && !databaseUrl) {
  throw new Error(
    'RULEBEAT_DATABASE_BACKEND is "postgres" but neither RULEBEAT_DATABASE_URL nor '
    + 'RULEBEAT_DATABASE_URL_FILE supplies a connection string. RuleBeat will not fall back to a '
    + 'SQLite database inside the container, because on a host with no persistent volume that '
    + 'database is lost on the next restart. Set the connection string on the running revision, '
    + 'or set RULEBEAT_DATABASE_BACKEND to "sqlite" to use the built-in database on purpose.',
  );
}

if (requestedBackend === 'sqlite' && databaseUrl) {
  throw new Error(
    'RULEBEAT_DATABASE_BACKEND is "sqlite" but RULEBEAT_DATABASE_URL (or its _FILE variant) is '
    + 'also set, and the two contradict each other. Remove the connection string to run on '
    + 'SQLite, or set RULEBEAT_DATABASE_BACKEND to "postgres".',
  );
}

export type DbKind = 'sqlite' | 'pg';

export const dbKind: DbKind = databaseUrl ? 'pg' : 'sqlite';

/** How the backend was chosen: the explicit selector, the connection string alone, or neither. */
export type BackendSelectedBy = 'RULEBEAT_DATABASE_BACKEND' | UrlSource | 'default';

export interface DatabaseBackendInfo {
  kind: DbBackendName;
  selectedBy: BackendSelectedBy;
  /** Postgres only. Parsed from the connection string; the password is never included. */
  host?: string;
  port?: number;
  database?: string;
  user?: string;
}

/**
 * The active backend, described for the boot log and the Diagnostics page. Everything here is
 * safe to print: the connection string's password is parsed out and never returned, and a
 * connection string `new URL()` cannot parse still yields the kind and selector.
 */
export function describeBackend(): DatabaseBackendInfo {
  const selectedBy: BackendSelectedBy = requestedBackend
    ? 'RULEBEAT_DATABASE_BACKEND'
    : resolvedUrl?.source ?? 'default';

  if (!databaseUrl) return { kind: 'sqlite', selectedBy };

  const info: DatabaseBackendInfo = { kind: 'postgres', selectedBy };
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.hostname) info.host = parsed.hostname;
    info.port = parsed.port ? Number(parsed.port) : 5432;
    const database = parsed.pathname.replace(/^\//, '');
    if (database) info.database = decodeURIComponent(database);
    if (parsed.username) info.user = decodeURIComponent(parsed.username);
  } catch {
    // Unparseable by the URL class (some libpq-style strings are). The kind and selector are
    // still correct, and the driver reports its own error if the string is unusable.
  }
  return info;
}

/**
 * One human sentence for the boot log and Diagnostics, from `describeBackend()`. `sqliteFile` is
 * supplied by the caller because the file path is decided in `lib/db/client.ts`, which this
 * module must not import (client.ts opens the database at import time).
 */
export function formatBackend(info: DatabaseBackendInfo, sqliteFile: string | null): string {
  const chosen = info.selectedBy === 'default'
    ? 'nothing selected it: RULEBEAT_DATABASE_URL is unset'
    : `selected by ${info.selectedBy}`;
  if (info.kind === 'sqlite') {
    return `SQLite at ${sqliteFile ?? 'the data directory'} (${chosen})`;
  }
  const where = [info.host ?? 'unknown host', info.port ? `:${info.port}` : '', info.database ? `/${info.database}` : '']
    .join('');
  const asUser = info.user ? ` as ${info.user}` : '';
  return `PostgreSQL at ${where}${asUser} (${chosen})`;
}
