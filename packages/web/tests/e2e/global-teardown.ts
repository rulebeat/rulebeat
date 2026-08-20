import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WEB_ROOT = join(__dirname, '..', '..');
const REAL_PASSWORD_FILE = join(WEB_ROOT, 'data', 'initial-password.txt');
const BACKUP_PASSWORD_FILE = join(WEB_ROOT, 'data', 'initial-password.txt.e2e-backup');

const STATE_DIR = join(tmpdir(), 'rulebeat-e2e');
const STATE_FILE = join(STATE_DIR, 'state.json');

export default async function globalTeardown(): Promise<void> {
  if (existsSync(STATE_FILE)) {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { pid: number; dbPath: string };
    try {
      if (process.platform === 'win32') {
        // -T kills the whole process tree: `spawn` with shell:true on Windows starts cmd.exe,
        // which then starts node — killing only the recorded pid would leave `next start`'s node
        // process running as an orphan.
        execFileSync('taskkill', ['/F', '/T', '/PID', String(state.pid)], { stdio: 'ignore' });
      } else {
        // global-setup.ts spawned with `detached: true`, which on POSIX makes the child the
        // leader of its own process group (pgid === pid). Killing -pid (negative) signals the
        // whole group — shell:true's /bin/sh plus the `next start` node process it launched —
        // instead of just the shell, which would leave next start running as an orphan.
        process.kill(-state.pid, 'SIGKILL');
      }
    } catch {
      // already exited
    }
    for (const suffix of ['', '-wal', '-shm']) {
      const f = `${state.dbPath}${suffix}`;
      if (existsSync(f)) rmSync(f);
    }
  }

  // Restore whatever the developer's real initial-password.txt held before this run, or remove it
  // if it didn't exist before — never leave the e2e admin's credentials sitting in the real data dir.
  if (existsSync(BACKUP_PASSWORD_FILE)) {
    writeFileSync(REAL_PASSWORD_FILE, readFileSync(BACKUP_PASSWORD_FILE));
    rmSync(BACKUP_PASSWORD_FILE);
  } else if (existsSync(REAL_PASSWORD_FILE)) {
    rmSync(REAL_PASSWORD_FILE);
  }
}
