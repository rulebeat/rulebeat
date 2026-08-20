import { test, expect } from '@playwright/test';
import { ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD, VIEWER_EMAIL, VIEWER_PASSWORD } from './fixtures';
import { signIn } from './helpers';

test('admin adds a viewer user from Settings, then a viewer signs in and sees no mutation controls', async ({ page }) => {
  await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);

  const newUserEmail = `e2e-invited-${Date.now()}@rulebeat.local`;

  await page.goto(`${ADMIN_URL}/settings`);
  await page.getByRole('button', { name: 'Add user' }).click();
  await page.getByLabel('Work email').fill(newUserEmail);
  // exact: true — Settings also has an unrelated "Add channel" button (notifications) whose
  // accessible name otherwise matches this substring search.
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  await expect(page.getByText(newUserEmail)).toBeVisible({ timeout: 10_000 });

  await page.getByTitle('Sign out').click();
  await page.waitForURL(url => url.pathname.startsWith('/signin'), { timeout: 15_000 });

  await signIn(page, ADMIN_URL, VIEWER_EMAIL, VIEWER_PASSWORD);

  await page.goto(`${ADMIN_URL}/library`);
  await expect(page.getByRole('link', { name: 'New rule' })).toHaveCount(0);

  await page.goto(`${ADMIN_URL}/scans?tab=results`);
  await expect(page.getByRole('button', { name: 'Run Scan' })).toHaveCount(0);

  await page.goto(`${ADMIN_URL}/settings`);
  await expect(page.getByText('Add user')).toHaveCount(0);
});
