import { test, expect, type Page } from '@playwright/test';
import { ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD, VIEWER_EMAIL, VIEWER_PASSWORD } from './fixtures';
import { signIn } from './helpers';

// scripts/seed-e2e.ts records a second, newer version (1.1.0, a different query) for this one enabled
// RuleBeat Core rule. No other spec reads or changes it, so these tests own its state and run in order.
const VERSIONED_RULE = 'Empty Network Security Group';
const UNVERSIONED_COMPARISON_RULE = 'Key Vault Soft Delete Disabled';

test.describe.configure({ mode: 'serial' });

/** The cell a row holds under a header. textContent, not innerText: the headers are uppercased by CSS. */
async function cellUnder(page: Page, ruleName: string, header: string) {
  const headers = await page.locator('thead th').allTextContents();
  const index = headers.findIndex(h => h.trim() === header);
  expect(index, `a "${header}" column`).toBeGreaterThanOrEqual(0);
  return page.locator('tr', { hasText: ruleName }).locator('td').nth(index);
}

async function openVersionedRule(page: Page): Promise<void> {
  await page.goto(`${ADMIN_URL}/library`);
  await page.getByRole('link', { name: VERSIONED_RULE, exact: true }).click();
  await page.waitForURL(/\/rules\/[^/]+$/);
  await expect(page.getByRole('list', { name: 'Rule versions' })).toBeVisible();
}

const versionRow = (page: Page, version: string) =>
  page.getByRole('list', { name: 'Rule versions' }).getByRole('listitem').filter({ hasText: version });

test('the library has a Version column with no Version filter, and marks a rule with a newer version', async ({ page }) => {
  await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto(`${ADMIN_URL}/library`);
  await expect(page.locator('tr', { hasText: VERSIONED_RULE })).toBeVisible();

  const headers = (await page.locator('thead th').allTextContents()).map(h => h.trim());
  expect(headers.indexOf('Version'), 'Version sits directly after Rule').toBe(headers.indexOf('Rule') + 1);
  await expect(page.locator('thead th', { hasText: 'Version' }).getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Version/ })).toHaveCount(0);

  await expect(await cellUnder(page, UNVERSIONED_COMPARISON_RULE, 'Version')).toHaveText('1.0.0');
  const marked = await cellUnder(page, VERSIONED_RULE, 'Version');
  await expect(marked).toContainText('1.0.0');
  const chip = marked.getByText('New', { exact: true });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute('title', /1\.1\.0.*1\.0\.0/);

  // An APRL rule shows its upstream commit date, not the timestamp.
  await expect(page.locator('tbody tr td:nth-child(2)').filter({ hasText: /^\d{4}-\d{2}-\d{2}$/ }).first()).toBeVisible();
});

test('the rule page lists every recorded version newest first and marks the one running', async ({ page }) => {
  await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
  await openVersionedRule(page);

  const items = page.getByRole('list', { name: 'Rule versions' }).getByRole('listitem');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('1.1.0');
  await expect(items.nth(0)).toContainText('New');
  await expect(items.nth(1)).toContainText('1.0.0');
  await expect(items.nth(1)).toContainText('Running');
  await expect(page.getByText('A disabled rule moves to the newest version when RuleBeat is upgraded.')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Rule version' })).toHaveCount(0);
  await expect(page.locator('details', { hasText: 'Version history' })).toHaveCount(0);
});

test('selecting the newer version opens the review, and an admin can switch to it', async ({ page }) => {
  await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
  await openVersionedRule(page);

  await versionRow(page, '1.1.0').getByRole('button').click();
  const review = page.getByRole('region', { name: 'Version changes' });
  await expect(review).toBeVisible();
  await expect(review.getByText('Raw KQL')).toBeVisible();
  await expect(review.getByLabel('Query line diff')).toContainText("where name !startswith 'e2e-'");

  await review.getByRole('button', { name: 'Switch version' }).click();
  await expect(versionRow(page, '1.1.0')).toContainText('Running');
  await expect(versionRow(page, '1.0.0')).not.toContainText('Running');
  await expect(page.getByRole('region', { name: 'Version changes' })).toHaveCount(0);

  await page.goto(`${ADMIN_URL}/library`);
  const cell = await cellUnder(page, VERSIONED_RULE, 'Version');
  await expect(cell).toContainText('1.1.0');
  await expect(cell.getByText('New', { exact: true })).toHaveCount(0);
});

test('a viewer sees the list and the review, and no Switch version', async ({ page }) => {
  await signIn(page, ADMIN_URL, VIEWER_EMAIL, VIEWER_PASSWORD);
  await openVersionedRule(page);

  const items = page.getByRole('list', { name: 'Rule versions' }).getByRole('listitem');
  await expect(items).toHaveCount(2);
  // Whichever version is not running, so this test does not depend on the one before it.
  await items.filter({ hasNotText: 'Running' }).getByRole('button').click();
  await expect(page.getByRole('region', { name: 'Version changes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Switch version' })).toHaveCount(0);
  await expect(page.getByText('Only an admin can switch Rule versions.')).toBeVisible();
});
