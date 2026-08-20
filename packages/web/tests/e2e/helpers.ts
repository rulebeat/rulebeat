import type { Page } from '@playwright/test';

/** Signs in through the real local-account credentials form and waits for the post-sign-in
 *  redirect to land somewhere other than /signin. Used by every spec against the admin-fixture
 *  server (port 3802) — see fixtures.ts for the seeded accounts. */
export async function signIn(page: Page, baseUrl: string, email: string, password: string): Promise<void> {
  await page.goto(`${baseUrl}/signin`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  // Button text is "Sign in" with no SSO configured, "Sign in with a local account" when
  // Microsoft SSO is also offered (env-configured on this dev machine's .env.local, which
  // `next start` loads regardless of what global-setup.ts passes as explicit env vars) — scope to
  // the form containing the password field so the Microsoft SSO button's own "Sign in with
  // Microsoft" text never matches.
  const localForm = page.locator('form').filter({ has: page.getByLabel('Password') });
  await localForm.getByRole('button', { name: /Sign in/ }).click();
  await page.waitForURL(url => !url.pathname.startsWith('/signin'), { timeout: 15_000 });
}
