#!/usr/bin/env node
// rulebeat-demo: commands for a running Demo, run inside its container.
//
//   rulebeat-demo reset    Reset the Demo now, the same way the timer does.
//
// The server holds the database open and may be mid-scan, so this never touches the database. It
// leaves a request next to it and signals the server, which does the Reset itself and writes the
// result back (lib/demo/live-reset.ts). Plain JavaScript with no dependencies, because the image
// ships the compiled server, not the source.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Must match lib/demo/live-reset.ts.
export const PID_FILE = 'demo-server.pid';
export const REQUEST_FILE = 'demo-reset-request.json';
export const RESULT_FILE = 'demo-reset-result.json';

/** The server's data directory: the working directory's `data`, which is where the image starts. */
export function findDataDir(cwd = process.cwd()) {
  for (const dir of [join(cwd, 'data'), '/app/packages/web/data']) {
    if (existsSync(join(dir, PID_FILE))) return dir;
  }
  return null;
}

/**
 * Asks the server whose pid is in `dataDir` to Reset the Demo, and waits for its answer.
 * Resolves to the server's result, or throws with a message for the operator.
 *
 * @param {{ dataDir: string, signal?: (pid: number) => void, timeoutMs?: number, pollMs?: number }} opts
 */
export async function requestReset({
  dataDir,
  signal = (pid) => process.kill(pid, 'SIGUSR2'),
  timeoutMs = 120_000,
  pollMs = 250,
}) {
  const pid = Number.parseInt(readFileSync(join(dataDir, PID_FILE), 'utf8').trim(), 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`${join(dataDir, PID_FILE)} does not hold a process id.`);

  const id = randomUUID();
  const resultPath = join(dataDir, RESULT_FILE);
  rmSync(resultPath, { force: true });
  writeFileSync(join(dataDir, REQUEST_FILE), JSON.stringify({ id }));
  try {
    signal(pid);
  } catch (err) {
    rmSync(join(dataDir, REQUEST_FILE), { force: true });
    throw new Error(`Could not reach the RuleBeat server (pid ${pid}): ${err instanceof Error ? err.message : err}`);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(resultPath)) {
      const result = JSON.parse(readFileSync(resultPath, 'utf8'));
      if (result.id === id) return result;
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error(`The server did not answer within ${Math.round(timeoutMs / 1000)} seconds. A scan may still be running; try again, or restart the container.`);
}

async function main(argv) {
  const [command] = argv;
  if (command !== 'reset') {
    console.error('Usage: rulebeat-demo reset');
    return 2;
  }
  const dataDir = findDataDir();
  if (!dataDir) {
    console.error('No running Demo found. Run this inside the Demo container while the server is up.');
    return 1;
  }
  try {
    const result = await requestReset({ dataDir });
    if (!result.ok) {
      console.error(`The Reset failed: ${result.error}`);
      return 1;
    }
    console.log(`The Demo was reset at ${result.resetAt}.`);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
