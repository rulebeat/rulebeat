import { defineConfig, devices } from '@playwright/test';
import { DEMO_URL } from './tests/e2e/fixtures';

// Chromium-only, single-worker: this suite mutates shared server-side state (rules, suppressions,
// users) against one temp admin database, so parallel workers would race each other. The demo
// server is read-only and needs no such isolation, but there's no value in a second browser
// engine for a suite this size.
//
// Two servers, because a single Next.js process can't run both RULEBEAT_DEMO=1 (read-only,
// pre-populated) and a normal local-admin install (mutation-testing) at once — it's a build/
// startup-time env toggle, not a per-request one. The demo server is started here through
// Playwright's own webServer (nothing to seed beyond the already-generated data/demo.db). The
// admin-fixture server needs a seed step to finish before it's allowed to boot, so it's started
// by hand in global-setup.ts instead — see the comment there for why.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: 'npx next start -p 3801',
      url: DEMO_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      // Same AUTH_URL override as global-setup.ts's admin-fixture server — the developer's
      // .env.local pins AUTH_URL to :3000, which `next start` would otherwise leave in place.
      env: { RULEBEAT_DEMO: '1', AUTH_URL: DEMO_URL },
    },
  ],
});
