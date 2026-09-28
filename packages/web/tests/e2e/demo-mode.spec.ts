import { test, expect } from '@playwright/test';
import { DEMO_URL } from './fixtures';

test('a Demo signs the Visitor in as an admin, is writable, and is pre-populated with data', async ({ page }) => {
  await page.goto(`${DEMO_URL}/dashboard`);

  // No sign-in required: the app acts as the seeded Demo Visitor, an admin.
  await page.waitForURL(/\/dashboards\/[^/]+$/, { timeout: 15_000 });
  await expect(page.locator('[data-widget-body]').first()).toBeVisible({ timeout: 15_000 });

  await page.goto(`${DEMO_URL}/library`);
  await expect(page.getByRole('link', { name: 'New rule' })).toBeVisible();

  // The Locked surfaces stay visible, with the reason, and cannot be changed.
  await page.goto(`${DEMO_URL}/settings`);
  await expect(page.getByText('The Azure connection is locked in the Demo.', { exact: false })).toBeVisible();

  await page.goto(`${DEMO_URL}/signin`);
  await page.waitForURL(url => !url.pathname.startsWith('/signin'), { timeout: 15_000 });

  await page.goto(`${DEMO_URL}/scans?tab=results`);
  // The generated demo estate has real findings. Results rows are plain aria-expanded buttons, not
  // <tr> elements — there is no HTML <table> on this view (see rules.spec.ts / suppressions.spec.ts
  // for the same finding).
  await expect(page.getByText(/\d+ findings?/)).toBeVisible({ timeout: 15_000 });
});
