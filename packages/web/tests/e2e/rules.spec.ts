import { test, expect } from '@playwright/test';
import { ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD } from './fixtures';
import { signIn } from './helpers';

test('admin creates a custom rule via the KQL editor, then deletes it', async ({ page }) => {
  await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);

  const ruleName = `E2E rule ${Date.now()}`;

  await page.goto(`${ADMIN_URL}/library`);
  await page.getByRole('link', { name: 'New rule' }).click();
  await page.waitForURL(/\/rules\/new$/);

  await page.getByPlaceholder('e.g. Required tag: Environment').fill(ruleName);

  // The KQL textarea is the only one on the page styled font-mono (Description is a plain Textarea).
  await page.locator('textarea.font-mono').fill('| where tolower(name) startswith "e2e"');

  await page.getByRole('button', { name: 'Create Rule' }).click();
  await page.waitForURL(/\/library$/, { timeout: 15_000 });

  await expect(page.getByText(ruleName)).toBeVisible({ timeout: 10_000 });

  const row = page.locator('tr', { hasText: ruleName });
  page.once('dialog', dialog => dialog.accept());
  await row.getByTitle('Delete rule').click();

  await expect(page.getByText(ruleName)).toHaveCount(0, { timeout: 10_000 });
});
