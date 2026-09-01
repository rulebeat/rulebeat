import { AsyncLocalStorage } from 'node:async_hooks';
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
let sqliteTxLock: Promise<void> | null = null;

async function settle(): Promise<void> {
  await dbReady;
  if (dbKind !== 'sqlite') return;
  if (txStore.getStore()) return; // inside inTransaction(): the lock is ours, don't wait on it
  while (sqliteTxLock) await sqliteTxLock;
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
export async function inTransaction<T>(fn: (tx: DbHandle) => Promise<T>): Promise<T> {
  const enclosing = txStore.getStore();
  if (enclosing) return fn(enclosing);

  await dbReady;

  if (dbKind === 'pg') {
    return pgDb!.transaction((tx) => {
      const handle = tx as unknown as DbHandle;
      return txStore.run(handle, () => fn(handle));
    });
  }

  while (sqliteTxLock) await sqliteTxLock;
  let release!: () => void;
  sqliteTxLock = new Promise<void>((resolve) => { release = resolve; });
  try {
    rawSqlite!.exec('BEGIN IMMEDIATE');
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
    sqliteTxLock = null;
    release();
  }
}
