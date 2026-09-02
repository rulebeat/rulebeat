import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD } from './fixtures';
import { signIn } from './helpers';

test('the sign-in page shows the running version before anyone signs in', async ({ page }) => {
  // The same package.json the app itself reads through lib/version.ts, so this cannot pass on a
  // hard-coded string that drifts from the next release.
  const { version } = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string };
  await page.goto(`${ADMIN_URL}/signin`);
  await expect(page.getByTestId('signin-version')).toHaveText(`RuleBeat v${version}`);
});

test('admin signs in, lands on a dashboard with rendered widgets, then signs out', async ({ page }) => {
  await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);

  await page.waitForURL(/\/dashboards\/[^/]+$/, { timeout: 15_000 });

  const widgets = page.locator('[data-widget-body]');
  await expect(widgets.first()).toBeVisible({ timeout: 15_000 });
  expect(await widgets.count()).toBeGreaterThan(0);

  await page.getByTitle('Sign out').click();
  await page.waitForURL(url => url.pathname.startsWith('/signin'), { timeout: 15_000 });
});
