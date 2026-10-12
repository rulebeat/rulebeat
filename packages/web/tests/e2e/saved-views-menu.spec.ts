import { test, expect } from '@playwright/test';
import { ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD } from './fixtures';
import { signIn } from './helpers';

// The menu's content only renders once it opens, so a component that throws in there passes every
// page-load check and crashes the page on the first click. That is how the Views menu shipped.
test('the Views menu on Results opens without crashing the page', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));

  await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto(`${ADMIN_URL}/scans?tab=results`);
  await expect(page.getByText('e2estorage')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Views' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByText('Saved views', { exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Save current view' })).toBeVisible();
  expect(errors).toEqual([]);
});
