import { test, expect } from '@playwright/test';
import { ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD, VIEWER_EMAIL, VIEWER_PASSWORD } from './fixtures';
import { signIn } from './helpers';

test('admin adds a viewer user from Access, then a viewer signs in, sees no mutation controls and only their own access', async ({ page }) => {
  await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);

  const newUserEmail = `e2e-invited-${Date.now()}@rulebeat.local`;

  await page.goto(`${ADMIN_URL}/access`);
  await page.getByRole('button', { name: 'Add user' }).click();
  await page.getByLabel('Work email').fill(newUserEmail);
  // An invited Viewer is given what an Admin picks: nothing is preselected, and Add stays disabled until it is.
  await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  await page.getByLabel('Give access to Everything').check();
  // exact: true: the accessible name "Add user" otherwise matches this substring search too.
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  await expect(page.getByText(newUserEmail)).toBeVisible({ timeout: 10_000 });

  await page.getByTitle('Sign out').click();
  await page.waitForURL(url => url.pathname.startsWith('/signin'), { timeout: 15_000 });

  await signIn(page, ADMIN_URL, VIEWER_EMAIL, VIEWER_PASSWORD);

  await page.goto(`${ADMIN_URL}/library`);
  await expect(page.getByRole('link', { name: 'New rule' })).toHaveCount(0);

  await page.goto(`${ADMIN_URL}/scans?tab=results`);
  await expect(page.getByRole('button', { name: 'Run Scan' })).toHaveCount(0);

  // A Viewer has an Access page too: their own access, read-only, with no list of people and no controls.
  await expect(page.getByRole('link', { name: 'Access', exact: true })).toHaveCount(1);
  await page.goto(`${ADMIN_URL}/access`);
  await expect(page.getByText('Your access')).toBeVisible();
  await expect(page.getByText(newUserEmail)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add user' })).toHaveCount(0);
});
