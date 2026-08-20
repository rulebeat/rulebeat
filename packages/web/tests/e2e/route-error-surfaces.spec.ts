import { test, expect } from '@playwright/test';
import { ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD } from './fixtures';
import { signIn } from './helpers';

/**
 * Spec 015 — three separate framework paths, each needing its own assertion: an explicit
 * notFound() call in a guarded route, a genuinely unmatched route (no auth check runs at all),
 * and an uncaught render error caught by the nearest error.tsx boundary. global-error.tsx is
 * exempted per the spec (verified by hand — see §2 Risks) since triggering a genuine root-layout
 * failure isn't reachable the same way from outside the app.
 */
test.describe('route error and not-found surfaces (spec 015)', () => {
  test('an explicit notFound() call renders the branded not-found page', async ({ page }) => {
    await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto(`${ADMIN_URL}/dashboards/does-not-exist`);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to dashboard' })).toBeVisible();
  });

  test('a genuinely unmatched route renders the branded not-found page', async ({ page }) => {
    // proxy.ts guards every route except /signin and /api/auth/* — an unauthenticated request to
    // an unmatched path is redirected to /signin before Next ever resolves it as unmatched, so
    // this needs a session too, unlike the doc example this is drawn from.
    await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto(`${ADMIN_URL}/this-route-does-not-exist`);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to dashboard' })).toBeVisible();
  });

  test('an uncaught render error is caught by the branded error boundary', async ({ page }) => {
    await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto(`${ADMIN_URL}/dashboards/__e2e-throw__`);
    await expect(page.getByRole('heading', { name: 'Something went wrong' })).toBeVisible();
    const retry = page.getByRole('button', { name: 'Try again' });
    await expect(retry).toBeVisible();
    // unstable_retry() re-fetches and re-renders the segment — the route still throws, so the
    // same boundary reappears rather than the button doing nothing.
    await retry.click();
    await expect(page.getByRole('heading', { name: 'Something went wrong' })).toBeVisible();
  });
});
