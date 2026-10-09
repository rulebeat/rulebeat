import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

/**
 * A read-only SQLite connection of its own, for a read that outlives the app's one shared connection's
 * turn: an export, which is open for as long as its download is being read.
 *
 * The app's shared connection has one lock every transaction waits on, so a read that held it for the
 * length of a download would stop every other read and every scan save behind it. The database runs in
 * WAL mode, where a reader on its own connection sees the file as it was when its transaction began,
 * whatever commits meanwhile, and neither blocks nor is blocked by the writer. `BEGIN` plus one read
 * pins that snapshot; `end()` releases it.
 */

export type SnapshotHandle = BetterSQLite3Database<typeof schema>;

export interface Snapshot {
  handle: SnapshotHandle;
  /** Ends the transaction and closes the connection. Safe to call more than once. */
  end(): void;
}

// On globalThis for the same reason as the transaction lock in exec.ts: every loaded copy of this
// module has to count the same connections.
const counter = ((globalThis as typeof globalThis & { __rulebeatSnapshotConnections?: { open: number } })
  .__rulebeatSnapshotConnections ??= { open: 0 });

/** How many snapshot connections are open right now. */
export function openSnapshotConnections(): number {
  return counter.open;
}

export function openSnapshot(filePath: string): Snapshot {
  const connection = new Database(filePath, { readonly: true, fileMustExist: true });
  counter.open++;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    // A connection that is closing takes its transaction with it, so a commit that throws changes nothing.
    try { connection.exec('COMMIT'); } catch { /* noop */ }
    try { connection.close(); } finally { counter.open--; }
  };
  try {
    connection.pragma('busy_timeout = 30000');
    connection.exec('BEGIN');
    // A deferred transaction takes its snapshot at its first read, so make that read now.
    connection.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
  } catch (err) {
    end();
    throw err;
  }
  return { handle: drizzle(connection, { schema }), end };
}
