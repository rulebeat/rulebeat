import { test, expect } from '@playwright/test';
import { ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD } from './fixtures';
import { signIn } from './helpers';

test('an admin writing a new rule can choose its kind and add tags', async ({ page }) => {
  await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);

  await page.goto(`${ADMIN_URL}/rules/new`);
  await page.getByRole('button', { name: 'Resource configuration' }).click();

  await expect(page.getByRole('combobox', { name: 'Kind' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Tag', exact: true })).toBeVisible();
});

test('the library shows a rule\'s kind under Kind and its pack under Tags', async ({ page }) => {
  await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto(`${ADMIN_URL}/library`);

  const row = page.locator('tr', { hasText: 'Key Vault Soft Delete Disabled' });
  await expect(row).toBeVisible();
  // textContent, not innerText: the headers are uppercased by CSS.
  const headers = await page.locator('thead th').allTextContents();
  const cellUnder = (header: string) => {
    const i = headers.findIndex(h => h.trim() === header);
    expect(i, `a "${header}" column`).toBeGreaterThanOrEqual(0);
    return row.locator('td').nth(i);
  };

  await expect(cellUnder('Kind')).toHaveText('Problem');
  await expect(cellUnder('Tags')).toContainText('RuleBeat Core');
});

test('admin creates a custom rule via the KQL editor, then deletes it', async ({ page }) => {
  await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);

  const ruleName = `E2E rule ${Date.now()}`;

  await page.goto(`${ADMIN_URL}/library`);
  await page.getByRole('link', { name: 'New rule' }).click();
  await page.waitForURL(/\/rules\/new$/);
  await page.getByRole('button', { name: 'Resource configuration' }).click();

  await page.getByPlaceholder('e.g. Required tag: Environment').fill(ruleName);

  // The KQL textarea is the only one on the page styled font-mono (Description is a plain Textarea).
  await page.locator('textarea.font-mono').fill('Resources\n| where tolower(name) startswith "e2e"');
  // spec 044 fixed the save-payload staleness this used to work around with a 500ms wait: Create
  // Rule now re-parses kqlText fresh for the submitted payload, not just the client-side gate, so
  // clicking immediately after typing is a real regression guard rather than a race to avoid.
  await page.getByRole('button', { name: 'Create Rule' }).click();
  await page.waitForURL(/\/library$/, { timeout: 15_000 });

  await expect(page.getByText(ruleName)).toBeVisible({ timeout: 10_000 });

  const row = page.locator('tr', { hasText: ruleName });
  page.once('dialog', dialog => dialog.accept());
  await row.getByTitle('Delete rule').click();

  await expect(page.getByText(ruleName)).toHaveCount(0, { timeout: 10_000 });
});
