import { test, expect } from '@playwright/test';
import { ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD } from './fixtures';
import { signIn } from './helpers';

/**
 * Spec 011 — below 1024px the app has no defined layout, so a full-viewport overlay (rendered at
 * the root, above every portal) replaces it with a plain notice instead of letting a broken
 * layout, or a portalled surface underneath it, show through.
 */
test('below 1024px, the min-width overlay covers the page including an open portal', async ({ page }) => {
  await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.waitForURL(/\/dashboards\/[^/]+$/, { timeout: 15_000 });

  // Open the dashboard filter bar's date range picker, which portals its popover straight to
  // document.body — the exact case a wrapper that only hides `children` couldn't cover.
  await page.getByRole('button', { name: 'Custom' }).click();
  await expect(page.getByLabel('From')).toBeVisible();

  await page.setViewportSize({ width: 1023, height: 800 });

  const overlay = page.getByRole('alert', { name: /widen your browser window/i });
  await expect(overlay).toBeVisible();

  // The portal's Apply button is still in the DOM underneath, but must be unreachable — proving
  // the overlay sits above it in stacking order, not merely that the overlay itself renders.
  await expect(page.getByRole('button', { name: 'Apply' }).click({ timeout: 2_000 })).rejects.toThrow();
});

test('at 1024px, the overlay is absent and the app renders normally', async ({ page }) => {
  await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.waitForURL(/\/dashboards\/[^/]+$/, { timeout: 15_000 });

  await page.setViewportSize({ width: 1024, height: 800 });

  const overlay = page.getByRole('alert', { name: /widen your browser window/i });
  await expect(overlay).toBeHidden();
  await expect(page.locator('[data-widget-body]').first()).toBeVisible();
});

test('at 1024px, /library with both sidebars pinned has no horizontal page overflow', async ({ page }) => {
  await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.setViewportSize({ width: 1024, height: 800 });

  // library-client.tsx reads its own pin state from the sidebar:library cookie, defaulting to
  // pinned when unset (app/(app)/library/page.tsx) — matches the app's own worst-case reserved
  // width (256px app sidebar + 208px library panel) at the exact floor this spec sets.
  await page.goto(`${ADMIN_URL}/library`);
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();

  const hasOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasOverflow).toBe(false);
});
