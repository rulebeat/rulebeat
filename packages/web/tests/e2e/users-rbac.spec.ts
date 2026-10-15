import { test, expect, type Page } from '@playwright/test';
import { ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD, VIEWER_EMAIL, VIEWER_PASSWORD } from './fixtures';
import { signIn } from './helpers';

/**
 * Whether anything on the page scrolls sideways (#311). The app's one scroll region is an inner
 * `overflow-y-auto` element, which scrolls sideways too when its content is wider, so checking
 * `documentElement` alone would miss it: every element that can scroll on the x axis is checked.
 */
async function scrollsSideways(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const wide: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) wide.push('html');
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const { overflowX } = getComputedStyle(el);
      if ((overflowX === 'auto' || overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1) {
        wide.push(`${el.tagName.toLowerCase()}.${el.className}`);
      }
    }
    return wide;
  });
}

const accessChoice = (page: Page, name: RegExp) => page.getByRole('radiogroup', { name: 'Access' }).getByRole('radio', { name });
const roleChoice = (page: Page, name: RegExp) => page.getByRole('radiogroup', { name: 'Role' }).getByRole('radio', { name });

test('an admin adds a user on a page of their own, then changes their Role there, and nothing scrolls sideways at 1280px', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);

  // A long address, so the users table has something to cut short rather than widen for.
  const newUserEmail = `e2e-invited-with-a-long-address-${Date.now()}@subdomain.rulebeat-example.local`;

  await page.goto(`${ADMIN_URL}/access`);
  await expect(page.getByRole('link', { name: 'Add user' })).toBeVisible();
  expect(await scrollsSideways(page)).toEqual([]);

  await page.getByRole('link', { name: 'Add user' }).click();
  await page.waitForURL(url => url.pathname === '/access/users/new');
  expect(await scrollsSideways(page)).toEqual([]);

  await page.getByLabel('Work email').fill(newUserEmail);
  // An invited Viewer is given what an Admin picks: no access choice is preselected, and Add user stays
  // disabled until one is.
  await expect(roleChoice(page, /^Viewer/)).toBeChecked();
  await expect(page.getByRole('button', { name: 'Add user' })).toBeDisabled();
  await accessChoice(page, /^Everything/).check();
  await page.getByRole('button', { name: 'Add user' }).click();

  await page.waitForURL(url => url.pathname === '/access');
  const row = page.getByRole('row', { name: new RegExp(newUserEmail.replace(/[.]/g, '\\.')) });
  await expect(row).toContainText('Viewer', { timeout: 10_000 });
  await expect(row).toContainText('Everything, manual');
  expect(await scrollsSideways(page)).toEqual([]);

  // Each person opens their own page, where the Role is set in one place.
  await row.getByRole('link', { name: newUserEmail }).click();
  await page.waitForURL(url => url.pathname.startsWith('/access/users/'));
  await expect(accessChoice(page, /^Everything/)).toBeChecked();
  expect(await scrollsSideways(page)).toEqual([]);
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  await roleChoice(page, /^Editor/).check();
  await page.getByRole('button', { name: 'Save' }).click();

  await page.waitForURL(url => url.pathname === '/access');
  await expect(row).toContainText('Editor', { timeout: 10_000 });
  await expect(row).toContainText('Everything, manual');
});

test('a viewer sees no mutation controls and only their own access', async ({ page }) => {
  await signIn(page, ADMIN_URL, VIEWER_EMAIL, VIEWER_PASSWORD);

  await page.goto(`${ADMIN_URL}/library`);
  await expect(page.getByRole('link', { name: 'New rule' })).toHaveCount(0);

  await page.goto(`${ADMIN_URL}/scans?tab=results`);
  await expect(page.getByRole('button', { name: 'Run Scan' })).toHaveCount(0);

  // A Viewer has an Access page too: their own access, read-only, with no list of people and no controls.
  await expect(page.getByRole('link', { name: 'Access', exact: true })).toHaveCount(1);
  await page.goto(`${ADMIN_URL}/access`);
  await expect(page.getByText('Your access')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add user' })).toHaveCount(0);

  // The add user page is an Admin's only.
  const response = await page.goto(`${ADMIN_URL}/access/users/new`);
  expect(response?.status()).toBe(404);
});
