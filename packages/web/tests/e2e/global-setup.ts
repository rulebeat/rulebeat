import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMIN_EMAIL, ADMIN_PASSWORD, VIEWER_EMAIL, VIEWER_PASSWORD, ADMIN_URL } from './fixtures';

// The admin-fixture server is started here, by hand, rather than through Playwright's own
// `webServer` array — it needs a seed step (owner account + a viewer user + one synthetic
// finding) to run to completion, synchronously, before the server is allowed to boot and run its
// own idempotent seeding. Playwright's documented ordering between globalSetup and webServer
// startup isn't a contract worth relying on for that; owning both steps here removes the race
// entirely.
//
// DATA_DIR in lib/db/client.ts is fixed at `<cwd>/data` regardless of RULEBEAT_DB_PATH, so
// seedOwnerAccount() always writes data/initial-password.txt there — including the *real*
// developer data dir, since this process's cwd is packages/web. Only the database file itself
// moves; the password file's path does not. Back it up and restore it in teardown so a Playwright
// run never leaves a developer's real initial-password.txt overwritten with e2e credentials.

const WEB_ROOT = join(__dirname, '..', '..');
const REAL_PASSWORD_FILE = join(WEB_ROOT, 'data', 'initial-password.txt');
const BACKUP_PASSWORD_FILE = join(WEB_ROOT, 'data', 'initial-password.txt.e2e-backup');

const STATE_DIR = join(tmpdir(), 'rulebeat-e2e');
const STATE_FILE = join(STATE_DIR, 'state.json');
const SERVER_LOG_FILE = join(STATE_DIR, 'admin-server.log');

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

export default async function globalSetup(): Promise<void> {
  mkdirSync(STATE_DIR, { recursive: true });

  if (existsSync(REAL_PASSWORD_FILE)) {
    writeFileSync(BACKUP_PASSWORD_FILE, readFileSync(REAL_PASSWORD_FILE));
  } else if (existsSync(BACKUP_PASSWORD_FILE)) {
    rmSync(BACKUP_PASSWORD_FILE);
  }

  const dbPath = join(STATE_DIR, `admin-${Date.now()}.db`);
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${dbPath}${suffix}`;
    if (existsSync(f)) rmSync(f);
  }

  const sharedEnv = {
    ...process.env,
    RULEBEAT_DB_PATH: dbPath,
    RULEBEAT_INITIAL_ADMIN: ADMIN_EMAIL,
    RULEBEAT_INITIAL_PASSWORD: ADMIN_PASSWORD,
    // The developer's own .env.local pins AUTH_URL to http://localhost:3000 for the normal dev
    // server; `next start` loads .env.local regardless of what this process already set, but
    // Next.js never lets a .env file override a variable already present in process.env — so
    // setting it here (not just leaving it out) is what keeps next-auth's post-sign-in redirect
    // pointed at this server's own port instead of :3000, where nothing relevant is listening.
    AUTH_URL: ADMIN_URL,
  };

  execFileSync('npx', ['tsx', 'scripts/seed-e2e.ts'], {
    cwd: WEB_ROOT,
    stdio: 'inherit',
    shell: true,
    env: {
      ...sharedEnv,
      RULEBEAT_E2E_VIEWER_EMAIL: VIEWER_EMAIL,
      RULEBEAT_E2E_VIEWER_PASSWORD: VIEWER_PASSWORD,
    },
  });

  writeFileSync(SERVER_LOG_FILE, '');

  const child = spawn('npx', ['next', 'start', '-p', '3802'], {
    cwd: WEB_ROOT,
    env: sharedEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    detached: true,
  });
  child.unref();

  const logChunks: Buffer[] = [];
  const flushLog = () => writeFileSync(SERVER_LOG_FILE, Buffer.concat(logChunks));
  child.stdout?.on('data', d => { logChunks.push(d); flushLog(); });
  child.stderr?.on('data', d => { logChunks.push(d); flushLog(); });

  writeFileSync(STATE_FILE, JSON.stringify({ pid: child.pid, dbPath }, null, 2));

  try {
    await waitForServer(`${ADMIN_URL}/signin`, 60_000);
  } catch (err) {
    flushLog();
    console.error(`[global-setup] admin server failed to come up; log at ${SERVER_LOG_FILE}`);
    throw err;
  }
}
