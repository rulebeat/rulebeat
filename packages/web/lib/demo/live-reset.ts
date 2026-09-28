import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { withExclusiveSqlite } from '../db/exec';
import { DATA_DIR } from '../db/sqlite-path';
import { whileNoScanRuns } from '../scheduler';
import { currentDemoSnapshotPath } from './boot';
import { resolveDemoResetSettings } from './config';
import { setNextDemoResetAt } from './readiness';
import { resetDemoDatabase } from './reset';

/**
 * A Reset of the running Demo: waits for any scan in flight to finish, then replaces the data from
 * the snapshot through the app's own connection (./reset.ts). Two things start one: the timer
 * below, and `rulebeat-demo reset` run inside the container. There is no HTTP way to start one,
 * since every Visitor is an admin (ADR 0002).
 */
export async function resetLiveDemo(opts: { now?: Date; snapshotPath?: string } = {}): Promise<Date> {
  const snapshot = opts.snapshotPath ?? currentDemoSnapshotPath();
  return whileNoScanRuns(() => withExclusiveSqlite(sqlite => {
    const now = opts.now ?? new Date();
    resetDemoDatabase(sqlite, snapshot, now);
    return now;
  }));
}

/**
 * The first wall-clock boundary of the interval after `now`, counted from local midnight: with 60
 * minutes, the top of the next hour; with 30, the next :00 or :30. A Visitor can then tell when
 * the next Reset is without knowing when the container started.
 */
export function nextDemoResetAt(now: Date, minutes: number): Date {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const step = minutes * 60_000;
  const elapsed = now.getTime() - midnight.getTime();
  const next = new Date(midnight.getTime() + (Math.floor(elapsed / step) + 1) * step);
  // An interval that does not divide a day evenly restarts its count at the next midnight.
  const nextMidnight = new Date(midnight);
  nextMidnight.setDate(nextMidnight.getDate() + 1);
  return next.getTime() > nextMidnight.getTime() ? nextMidnight : next;
}

/** Starts the Reset timer, unless it is off (RULEBEAT_DEMO_RESET_MINUTES=0, or the Recording
 *  presentation). Called once from instrumentation.ts after the Demo is prepared. */
export function startDemoResetTimer(): void {
  const { resetMinutes } = resolveDemoResetSettings();
  const g = globalThis as typeof globalThis & { __rulebeatDemoTimerStarted?: boolean };
  if (resetMinutes === 0 || g.__rulebeatDemoTimerStarted) return;
  g.__rulebeatDemoTimerStarted = true;

  let previous = 0;
  const schedule = () => {
    // Counted from the boundary just served as well as the clock, so a timeout that fires a few
    // milliseconds early cannot land on the same boundary and reset twice.
    const at = nextDemoResetAt(new Date(Math.max(Date.now(), previous)), resetMinutes);
    previous = at.getTime();
    setNextDemoResetAt(at);
    const timer = setTimeout(() => {
      void resetLiveDemo()
        .then(() => console.log('[demo] Reset on the timer'))
        .catch(err => console.error('[demo] timed Reset failed:', err instanceof Error ? err.message : err))
        .finally(schedule);
    }, Math.max(0, at.getTime() - Date.now()));
    timer.unref();
  };
  schedule();
}

// ── `rulebeat-demo reset` ───────────────────────────────────────────────────────────────────────
// The command (bin/rulebeat-demo.mjs) cannot reset the database itself: the server holds it open
// and may be mid-scan. It writes a request file and sends this process SIGUSR2; the server does the
// Reset through its own connection and writes the result where the command is waiting for it.

export const DEMO_PID_FILE = 'demo-server.pid';
export const DEMO_RESET_REQUEST_FILE = 'demo-reset-request.json';
export const DEMO_RESET_RESULT_FILE = 'demo-reset-result.json';

/** Answers one `rulebeat-demo reset` request found in `dataDir`. */
export async function answerDemoResetRequest(
  dataDir: string = DATA_DIR,
  reset: () => Promise<Date> = () => resetLiveDemo(),
): Promise<void> {
  const requestPath = join(dataDir, DEMO_RESET_REQUEST_FILE);
  if (!existsSync(requestPath)) return;
  let id: string | null = null;
  try {
    const parsed = JSON.parse(readFileSync(requestPath, 'utf8')) as { id?: unknown };
    id = typeof parsed.id === 'string' ? parsed.id : null;
  } catch { /* unreadable: answered below without an id, so the command times out and says so */ }
  rmSync(requestPath, { force: true });

  let result: { id: string | null; ok: boolean; resetAt?: string; error?: string };
  try {
    result = { id, ok: true, resetAt: (await reset()).toISOString() };
  } catch (err) {
    result = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  writeFileSync(join(dataDir, DEMO_RESET_RESULT_FILE), JSON.stringify(result));
}

/** Lets `rulebeat-demo reset` find and signal this process. Not available on Windows, which has
 *  no SIGUSR2; a restart still resets the Demo there. */
export function listenForDemoResetRequests(dataDir: string = DATA_DIR): void {
  if (process.platform === 'win32') return;
  writeFileSync(join(dataDir, DEMO_PID_FILE), String(process.pid));
  process.on('SIGUSR2', () => {
    void answerDemoResetRequest(dataDir).catch(err => {
      console.error('[demo] rulebeat-demo reset failed:', err instanceof Error ? err.message : err);
    });
  });
}
