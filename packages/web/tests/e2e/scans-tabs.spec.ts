import { test, expect } from '@playwright/test';
import { ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD } from './fixtures';
import { signIn } from './helpers';

test('the four Scans tabs navigate and keep the URL in sync', async ({ page }) => {
  await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);

  await page.goto(`${ADMIN_URL}/scans`);
  await expect(page).toHaveURL(/tab=results/);
  // The finding's own `title` field ('E2E seeded finding') is never rendered in the Results view —
  // only the seeded resource name ('e2estorage', set in scripts/seed-e2e.ts) and the rule that
  // detected it are.
  await expect(page.getByText('e2estorage')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('link', { name: 'Run History' }).click();
  await expect(page).toHaveURL(/tab=history/);

  await page.getByRole('link', { name: /^Rules/ }).click();
  await expect(page).toHaveURL(/tab=rules/);

  // exact: true — the Rules tab lists rules whose own names can contain "Schedules" as a substring.
  await page.getByRole('link', { name: 'Schedules', exact: true }).click();
  await expect(page).toHaveURL(/tab=schedules/);

  await page.getByRole('link', { name: 'Results' }).click();
  await expect(page).toHaveURL(/tab=results/);
});
