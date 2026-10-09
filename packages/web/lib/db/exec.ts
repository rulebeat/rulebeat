import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { dbKind } from './backend';
import { db, dbReady, pgDb, rawSqlite } from './client';

/**
 * The terminator seam of the dual-backend design (issue #73).
 *
 * better-sqlite3 Drizzle executes with `.all()`/`.get()`/`.run()`, synchronously; node-postgres
 * Drizzle executes by awaiting the builder itself. A ported repository builds its query against
 * the statically-SQLite-typed `db` (see client.ts / tables.ts) and hands the *unterminated*
 * builder to `many`/`one`/`run` here, which applies the right terminator for the backend the
 * process actually opened. Repositories must never call `.all()`/`.get()`/`.run()` directly once
 * ported, or the Postgres path breaks at runtime.
 *
 * Multi-statement writes go through `inTransaction()`. On Postgres that is a real
 * `pgDb.transaction()`; on SQLite it is `BEGIN IMMEDIATE`/`COMMIT` on the raw connection guarded
 * by an in-process async lock, because an async function that yields mid-transaction would
 * otherwise let an interleaved caller's statement join (or deadlock against) the open
 * transaction on the single shared connection. better-sqlite3's own `db.transaction()` cannot be
 * used here: it requires a synchronous callback. The AsyncLocalStorage context is how the
 * `many`/`one`/`run` helpers know a call is *inside* the transaction (skip the lock gate, don't
 * self-deadlock) versus outside it (wait for the transaction to finish).
 */

export type DbHandle = typeof db;

const txStore = new AsyncLocalStorage<DbHandle>();
// On globalThis because instrumentation.ts (a Demo's Reset) and the route handlers can each load
// their own copy of this module, and the lock only works if they share it.
const txLock = ((globalThis as typeof globalThis & { __rulebeatSqliteTxLock?: { held: Promise<void> | null } })
  .__rulebeatSqliteTxLock ??= { held: null });

async function settle(): Promise<void> {
  await dbReady;
  if (dbKind !== 'sqlite') return;
  if (txStore.getStore()) return; // inside inTransaction(): the lock is ours, don't wait on it
  while (txLock.held) await txLock.held;
}

/** Executes a query expected to return zero or more rows. */
export async function many<T>(query: { all(): T[] }): Promise<T[]> {
  await settle();
  if (dbKind === 'pg') return await (query as unknown as PromiseLike<T[]>);
  return query.all();
}

/** Executes a query expected to return at most one row (first row wins, like `.get()`). */
export async function one<T>(query: { get(): T | undefined }): Promise<T | undefined> {
  await settle();
  if (dbKind === 'pg') {
    const rows = await (query as unknown as PromiseLike<T[]>);
    return rows[0];
  }
  return query.get();
}

/** Executes a statement for its side effect. */
export async function run(query: { run(): unknown }): Promise<void> {
  await settle();
  if (dbKind === 'pg') {
    await (query as unknown as PromiseLike<unknown>);
    return;
  }
  query.run();
}

/**
 * Runs `fn` inside a database transaction. All queries in `fn` MUST be built on the handle it
 * receives (not the module-level `db`), or on Postgres they would silently execute outside the
 * transaction. Nested calls join the enclosing transaction.
 */
export function inTransaction<T>(fn: (tx: DbHandle) => Promise<T>): Promise<T> {
  return runInTransaction(fn, 'write');
}

/**
 * Runs `fn` as one consistent read: every query in it, built on the handle it receives, sees the
 * database as it was when the first of them ran, whatever commits meanwhile (ADR 0007: a view is
 * answered from several reads that must agree). On Postgres that is a read-only REPEATABLE READ
 * transaction. On SQLite it is a deferred transaction on the one shared connection, held under the
 * same lock a write takes, so a write started meanwhile waits until the read is over. Joins a
 * transaction that is already open.
 */
export function inReadTransaction<T>(fn: (tx: DbHandle) => Promise<T>): Promise<T> {
  return runInTransaction(fn, 'read');
}

async function runInTransaction<T>(fn: (tx: DbHandle) => Promise<T>, mode: 'write' | 'read'): Promise<T> {
  const enclosing = txStore.getStore();
  if (enclosing) return fn(enclosing);

  await dbReady;

  if (dbKind === 'pg') {
    return pgDb!.transaction((tx) => {
      const handle = tx as unknown as DbHandle;
      return txStore.run(handle, () => fn(handle));
    }, mode === 'read' ? { isolationLevel: 'repeatable read', accessMode: 'read only' } : undefined);
  }

  while (txLock.held) await txLock.held;
  let release!: () => void;
  txLock.held = new Promise<void>((resolve) => { release = resolve; });
  try {
    rawSqlite!.exec(mode === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE');
    try {
      const result = await txStore.run(db, () => fn(db));
      rawSqlite!.exec('COMMIT');
      return result;
    } catch (err) {
      // Rollback can itself throw if the transaction already aborted; the original error is the
      // one worth surfacing.
      try { rawSqlite!.exec('ROLLBACK'); } catch { /* noop */ }
      throw err;
    }
  } finally {
    txLock.held = null;
    release();
  }
}

/**
 * Takes a Postgres transaction-scoped advisory lock on a fixed key, for a check-then-write inside
 * `inTransaction()` that must not let two concurrent transactions both pass the check. Postgres
 * runs at READ COMMITTED: each statement only sees rows committed before *that statement* started,
 * so two transactions opened close together can each run the same uniqueness check, see nothing
 * from the other (neither has committed yet), and both proceed to write. A transaction-scoped
 * advisory lock on a fixed key serializes the whole check-then-write around it instead: the second
 * caller blocks here until the first transaction commits or rolls back (which releases the lock
 * with it), so by the time the second caller's own check runs, it sees what the first one wrote.
 *
 * No-op on SQLite, where `inTransaction()` already serializes every writer through the process-wide
 * `txLock` above, so a second transaction cannot even begin until the first one has fully committed.
 */
export async function pgAdvisoryXactLock(tx: DbHandle, key: number): Promise<void> {
  if (dbKind !== 'pg') return;
  await (tx as unknown as { execute(query: unknown): Promise<unknown> }).execute(sql.raw(`SELECT pg_advisory_xact_lock(${key})`));
}

/**
 * Runs synchronous work on the raw SQLite connection with no transaction of anyone else's open
 * around it: waits for the transaction lock, holds it while `fn` runs, then releases it. For
 * statements that cannot run inside a transaction (ATTACH), such as the Demo's Reset
 * (lib/demo/reset.ts). SQLite only.
 */
export async function withExclusiveSqlite<T>(fn: (sqlite: NonNullable<typeof rawSqlite>) => T): Promise<T> {
  await dbReady;
  if (dbKind !== 'sqlite' || !rawSqlite) throw new Error('withExclusiveSqlite() needs the SQLite backend.');
  while (txLock.held) await txLock.held;
  let release!: () => void;
  txLock.held = new Promise<void>((resolve) => { release = resolve; });
  try {
    return fn(rawSqlite);
  } finally {
    txLock.held = null;
    release();
  }
}
