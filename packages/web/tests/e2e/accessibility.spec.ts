import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD } from './fixtures';
import { signIn } from './helpers';

/**
 * Spec 026 — no automated accessibility gate existed at all before this. Runs axe (serious/critical
 * impact only), a horizontal page-overflow check (same assertion as min-width-guard.spec.ts), and a
 * console-error check across the app's primary authenticated routes, in both themes.
 *
 * Deliberately not covered here (see spec 026 §1/§2 for why): dialog focus-trap behaviour
 * (dialog-accessibility.spec.ts's job), the sub-1024px overlay itself (min-width-guard.spec.ts's
 * job), and WCAG/contrast auditing beyond axe's own default serious/critical impact flags.
 */

// Same cookie lib/theme.ts reads — not imported directly since tests/e2e deliberately takes no
// dependency on product code (see fixtures.ts).
const THEME_COOKIE = 'theme';

const ROUTES = [
  '/signin',
  '/dashboard',
  '/library',
  '/scans?tab=results',
  '/scans?tab=rules',
  '/suppressions',
  '/settings',
  '/audit',
  '/diagnostics',
] as const;

// The three routes re-checked at the 1024px floor spec 011 already established — a subset, not the
// full 8-route matrix, to avoid an 8x2x2 case explosion for marginal added value (spec 026 §2).
const NARROW_ROUTES = ['/dashboard', '/scans?tab=results', '/settings'] as const;

const THEMES = ['light', 'dark'] as const;

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.context().addCookies([
    { name: THEME_COOKIE, value: theme, url: ADMIN_URL },
  ]);
}

/** Dashboard widgets self-fetch after mount and start in a loading state (useWidgetFetch) — running
 *  axe/overflow/console checks immediately after navigation would score the spinner, not the real
 *  content. Waits for network idle, then for every widget's own loading spinner (the `Loader2
 *  animate-spin` element every widgets/*-widget.tsx renders while `loading` is true) to clear. */
async function waitForRouteSettled(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await page.waitForFunction(
    () => document.querySelectorAll('[data-widget-body] .animate-spin').length === 0,
    undefined,
    { timeout: 30_000 },
  ).catch(() => {});
}

async function collectConsoleErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  return errors;
}

async function runChecks(page: Page, routeLabel: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow, `${routeLabel}: page has horizontal overflow`).toBe(false);

  const results = await new AxeBuilder({ page })
    .include('body')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  const serious = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
  expect(serious, `${routeLabel}: serious/critical axe violations: ${JSON.stringify(serious.map(v => ({ id: v.id, nodes: v.nodes.length })))}`).toEqual([]);
}

for (const theme of THEMES) {
  test.describe(`accessibility sweep — ${theme} theme`, () => {
    for (const route of ROUTES) {
      test(`${route} has no serious axe violations, no overflow, no console errors`, async ({ page }) => {
        const consoleErrors = await collectConsoleErrors(page);
        await setTheme(page, theme);

        if (route === '/signin') {
          await page.goto(`${ADMIN_URL}${route}`);
        } else {
          await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
          await page.goto(`${ADMIN_URL}${route}`);
        }
        await waitForRouteSettled(page);

        await runChecks(page, route);
        expect(consoleErrors, `${route}: console errors: ${JSON.stringify(consoleErrors)}`).toEqual([]);
      });
    }

    for (const route of NARROW_ROUTES) {
      test(`${route} at 1024px has no serious axe violations, no overflow, no console errors`, async ({ page }) => {
        const consoleErrors = await collectConsoleErrors(page);
        await setTheme(page, theme);
        await page.setViewportSize({ width: 1024, height: 800 });

        await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
        await page.goto(`${ADMIN_URL}${route}`);
        await waitForRouteSettled(page);

        await runChecks(page, `${route}@1024px`);
        expect(consoleErrors, `${route}@1024px: console errors: ${JSON.stringify(consoleErrors)}`).toEqual([]);
      });
    }
  });
}
