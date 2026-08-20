import { test, expect } from '@playwright/test';
import { DEMO_URL } from './fixtures';

test('demo mode is anonymous, read-only, and pre-populated with data', async ({ page }) => {
  await page.goto(`${DEMO_URL}/dashboard`);

  // No sign-in required: the app auto-authenticates as the seeded demo-visitor viewer.
  await page.waitForURL(/\/dashboards\/[^/]+$/, { timeout: 15_000 });
  await expect(page.locator('[data-widget-body]').first()).toBeVisible({ timeout: 15_000 });

  await page.goto(`${DEMO_URL}/library`);
  await expect(page.getByRole('link', { name: 'New rule' })).toHaveCount(0);

  await page.goto(`${DEMO_URL}/scans?tab=results`);
  await expect(page.getByRole('button', { name: 'Run Scan' })).toHaveCount(0);
  // The generated demo estate has real findings. Results rows are plain aria-expanded buttons, not
  // <tr> elements — there is no HTML <table> on this view (see rules.spec.ts / suppressions.spec.ts
  // for the same finding).
  await expect(page.getByText(/\d+ findings?/)).toBeVisible({ timeout: 15_000 });
});
