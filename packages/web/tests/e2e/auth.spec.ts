import { test, expect } from '@playwright/test';
import { ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD } from './fixtures';
import { signIn } from './helpers';

test('admin signs in, lands on a dashboard with rendered widgets, then signs out', async ({ page }) => {
  await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);

  await page.waitForURL(/\/dashboards\/[^/]+$/, { timeout: 15_000 });

  const widgets = page.locator('[data-widget-body]');
  await expect(widgets.first()).toBeVisible({ timeout: 15_000 });
  expect(await widgets.count()).toBeGreaterThan(0);

  await page.getByTitle('Sign out').click();
  await page.waitForURL(url => url.pathname.startsWith('/signin'), { timeout: 15_000 });
});
