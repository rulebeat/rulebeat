import { readFileSync } from 'fs';

/**
 * Which database backend this process runs against, decided once at first import.
 *
 * `RULEBEAT_DATABASE_URL` unset means SQLite, exactly as every install before this setting
 * existed. Set to a postgres:// connection string it means Postgres. The `_FILE` variant exists
 * for Docker/Compose secrets, same convention as `AUTH_SECRET_FILE` and the other secret vars.
 *
 * Deliberately the `RULEBEAT_`-prefixed name rather than bare `DATABASE_URL`: platforms inject
 * `DATABASE_URL` for databases that have nothing to do with RuleBeat, and an unrelated injected
 * value silently flipping the backend would violate "empty env = SQLite, explicit opt-in".
 *
 * Reads are literal `process.env.NAME` lookups, never dynamic, for the same bundler-inlining
 * reason documented in `lib/auth-secret.ts`.
 */
function resolveDatabaseUrl(): string | null {
  const direct = process.env.RULEBEAT_DATABASE_URL?.trim();
  if (direct) return direct;

  const file = process.env.RULEBEAT_DATABASE_URL_FILE?.trim();
  if (file) {
    // An unreadable secret file throws rather than falling back to SQLite: a misconfigured
    // Postgres deployment must fail loudly, not silently boot an empty SQLite database.
    const fromFile = readFileSync(file, 'utf8').trim();
    if (fromFile) return fromFile;
  }

  return null;
}

export const databaseUrl = resolveDatabaseUrl();

if (databaseUrl && !/^postgres(ql)?:\/\//i.test(databaseUrl)) {
  throw new Error(
    'RULEBEAT_DATABASE_URL must be a postgres:// or postgresql:// connection string. '
    + 'Leave it unset to use the built-in SQLite database.',
  );
}

export type DbKind = 'sqlite' | 'pg';

export const dbKind: DbKind = databaseUrl ? 'pg' : 'sqlite';
