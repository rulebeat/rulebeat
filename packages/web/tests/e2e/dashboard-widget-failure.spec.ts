import { test, expect } from '@playwright/test';
import { ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD } from './fixtures';
import { signIn } from './helpers';

/**
 * Spec 010 — a dashboard widget whose fetch fails must show the shared "Couldn't load this
 * widget" state, not a widget-specific empty-state message ("No data", "No violations found") or
 * an endless spinner. Intercepts the two summary-shaped endpoints the starter dashboard's stat-card
 * and top-rules widgets call, forces a 500, then lets the route succeed and checks Retry recovers.
 */
test('a failed widget fetch shows Unavailable, not an empty state, and Retry recovers it', async ({ page }) => {
  await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);

  let failSummary = true;
  await page.route('**/api/widgets/summary**', route => {
    if (failSummary) return route.fulfill({ status: 500, body: '{}' });
    return route.continue();
  });
  let failTopRules = true;
  await page.route('**/api/widgets/top-rules**', route => {
    if (failTopRules) return route.fulfill({ status: 500, body: '{}' });
    return route.continue();
  });

  await page.goto(`${ADMIN_URL}/dashboard`);
  await expect(page).toHaveURL(/\/dashboards\//);

  const unavailable = page.getByText("Couldn't load this widget");
  await expect(unavailable.first()).toBeVisible({ timeout: 15_000 });
  const initialCount = await unavailable.count();
  // Both the stat-card (posture-pct) and top-rules widgets on the starter dashboard hit one
  // of the two failed endpoints — at least two widgets should be showing the failure state.
  expect(initialCount).toBeGreaterThanOrEqual(2);

  await expect(page.getByText('No violations found')).toHaveCount(0);
  await expect(page.getByText('No data')).toHaveCount(0);

  failSummary = false;
  failTopRules = false;
  // Retry only re-fetches the one widget it was clicked on, not every failed widget on the
  // dashboard — so the assertion is that this specific widget recovers, not that the whole
  // page clears.
  await page.getByRole('button', { name: 'Retry' }).first().click();

  await expect(unavailable).toHaveCount(initialCount - 1, { timeout: 15_000 });
});
