import { test, expect, type Page } from '@playwright/test';
import { ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD } from './fixtures';
import { signIn } from './helpers';

/**
 * Spec 012 — NewDashboardDialog and SlideOverPanel (widget config / add widget) are rebuilt on
 * the shared components/ui/dialog.tsx wrapper around @base-ui/react/dialog. A naive "press
 * Escape, assert closed" test would already pass against the old hand-rolled implementation,
 * since NewDashboardDialog's own text input had its own Escape handler — none of that proves
 * the actual fix (focus trap + focus restoration). These tests specifically target focus
 * containment, Escape fired from a control that is NOT that input, and focus return to the
 * trigger, which only the real Base UI dialog satisfies.
 */

/** Presses Tab `count` times and asserts focus never leaves the dialog popup identified by
 *  data-slot="dialog-popup" — proof of the focus trap, not just that Escape happens to work.
 *
 *  Base UI's trap is implemented with invisible focus-guard siblings of the popup: tabbing off
 *  the last (or first) tabbable element inside briefly lands on a guard, whose onFocus handler
 *  redirects focus back inside via requestAnimationFrame (enqueueFocus), not synchronously. A
 *  check taken immediately after the Tab keypress can race that frame and observe focus on the
 *  guard — outside the popup — for an instant even though the trap is working. Waiting one frame
 *  before reading document.activeElement asserts the trap's settled state instead of that hop. */
async function assertFocusStaysTrapped(page: Page, count: number) {
  for (let i = 0; i < count; i++) {
    await page.keyboard.press('Tab');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    const inside = await page.evaluate(() => {
      const popup = document.querySelector('[data-slot="dialog-popup"]');
      return !!popup && !!document.activeElement && popup.contains(document.activeElement);
    });
    expect(inside).toBe(true);
  }
}

test('NewDashboardDialog has an accessible name, traps focus, closes on Escape outside the input, and returns focus to the trigger', async ({ page }) => {
  await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.waitForURL(/\/dashboards\/[^/]+$/, { timeout: 15_000 });
  await page.goto(`${ADMIN_URL}/dashboards`);

  const trigger = page.getByRole('button', { name: 'New Dashboard' }).first();
  await trigger.click();

  const dialog = page.getByRole('dialog', { name: 'New dashboard' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName('New dashboard');

  await assertFocusStaysTrapped(page, 8);

  // Move focus to a control that is not the text input, then Escape — the input's own
  // Escape-to-close handler (if it still existed) would not fire here.
  const cancelButton = dialog.getByRole('button', { name: 'Cancel' });
  await cancelButton.focus();
  await expect(cancelButton).toBeFocused();
  await page.keyboard.press('Escape');

  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('SlideOverPanel (widget config) has an accessible name, traps focus, closes on Escape outside any input, returns focus, and a nested checklist dropdown still opens inside the trap', async ({ page }) => {
  await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.waitForURL(/\/dashboards\/[^/]+$/, { timeout: 15_000 });

  await page.getByRole('button', { name: 'Edit' }).click();
  const configureButton = page.getByTitle('Configure').first();
  await configureButton.click();

  const panel = page.getByRole('dialog', { name: 'Configure Widget' });
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAccessibleName('Configure Widget');

  await assertFocusStaysTrapped(page, 10);

  // A nested portalled control (ChecklistDropdown, built on the same Popover primitive) must
  // still open and accept input while the outer dialog holds a focus trap — a trap that also
  // swallows focus meant for a nested portal is a real failure mode this rewrite could introduce.
  await panel.getByRole('button', { name: 'Subscription', exact: true }).click();
  const search = page.getByPlaceholder('Filter subscription');
  await expect(search).toBeVisible();
  await search.fill('anything');
  await expect(search).toHaveValue('anything');
  // Close the nested popover the same way it opened, leaving the outer dialog untouched.
  await panel.getByRole('button', { name: 'Subscription', exact: true }).click();
  await expect(search).toBeHidden();
  await expect(panel).toBeVisible();

  const cancelButton = panel.getByRole('button', { name: 'Cancel' });
  await cancelButton.focus();
  await expect(cancelButton).toBeFocused();
  await page.keyboard.press('Escape');

  await expect(panel).toBeHidden();
  await expect(configureButton).toBeFocused();
});
