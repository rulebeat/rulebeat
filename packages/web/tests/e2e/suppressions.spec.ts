import { test, expect } from '@playwright/test';
import { ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD } from './fixtures';
import { signIn } from './helpers';

// The seeded finding's resourceName ('e2estorage', set in scripts/seed-e2e.ts) is what actually
// renders in the Results view — the finding's own `title` field is never displayed there, only the
// detecting rule's name and the resource. Rows in both the Results explorer and the Suppressions
// list are plain divs/buttons (aria-expanded), not <tr> elements — there is no HTML <table> here.
const RESOURCE_NAME = 'e2estorage';

test('admin suppresses the seeded finding, then removes the suppression', async ({ page }) => {
  await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);

  await page.goto(`${ADMIN_URL}/scans?tab=results`);
  const row = page.getByRole('button', { name: new RegExp(RESOURCE_NAME) });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();

  await page.getByPlaceholder('Reason (e.g. accepted risk, false positive)').fill('E2E suppression reason');
  await page.getByRole('button', { name: 'Suppress' }).click();

  // A suppressed finding is filtered out of the default (non-"show suppressed") view the moment
  // suppression state updates, so the confirmation is the counter appearing, not the row itself.
  await expect(page.getByRole('button', { name: /Show suppressed \(1\)/ })).toBeVisible({ timeout: 10_000 });

  await page.goto(`${ADMIN_URL}/suppressions`);
  await expect(page.getByText('E2E suppression reason')).toBeVisible({ timeout: 15_000 });
  await page.getByTitle('Remove suppression').click();

  await expect(page.getByText('E2E suppression reason')).toHaveCount(0, { timeout: 10_000 });
});
