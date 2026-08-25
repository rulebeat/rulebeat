import { test, expect, type Page } from '@playwright/test';
import { ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD } from './fixtures';
import { signIn } from './helpers';

/**
 * The docs pass found the default dashboard loading with an active "Save changes" button that no
 * one had earned — the capture had to remove it with a DOM edit. Dirty was inferred from
 * onLayoutChange behind a 300ms suppression window around the fit-to-content pass, and any
 * machine-made position change that landed outside that window read as a person's drag: the
 * mount-time compaction of a stored layout the grid packs differently, overlapping fit passes on
 * a fresh load, and the grid's async reset right after Cancel. Dirty is now gated on edit mode
 * (drag and resize only exist there, and the fit-to-content pass never runs there), so:
 *
 *  - a dashboard whose stored layout the grid re-packs at mount must load clean,
 *  - the default dashboard must load clean, and
 *  - a drag followed by Cancel must stay clean.
 *
 * The first dashboard is stored with a deliberate vertical gap, which mount-time compaction
 * closes — a deterministic machine-made move, unlike racing the 300ms window.
 */

const SAVE_CHANGES = /^Save changes$/;

let gappedId: string | null = null;

async function createGappedDashboard(page: Page): Promise<string> {
  const res = await page.request.post(`${ADMIN_URL}/api/dashboards`, {
    data: {
      name: `E2E dirty-on-load ${Date.now()}`,
      config: {
        autoRefresh: 0,
        widgets: [
          { id: 'g1', type: 'stat-card', title: 'Gap probe A', x: 0, y: 0, w: 3, h: 3, config: { metric: 'posture-pct' } },
          // y: 6 leaves rows 3-5 empty; vertical compaction moves this to y: 3 on mount.
          { id: 'g2', type: 'stat-card', title: 'Gap probe B', x: 0, y: 6, w: 3, h: 3, config: { metric: 'total-findings' } },
        ],
      },
    },
  });
  expect(res.status()).toBe(201);
  const dashboard = await res.json() as { id: string };
  return dashboard.id;
}

test('a stored layout the grid compacts at mount loads without Save changes', async ({ page }) => {
  await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
  gappedId = await createGappedDashboard(page);

  await page.goto(`${ADMIN_URL}/dashboards/${gappedId}`);
  await expect(page.getByText('Gap probe A')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Gap probe B')).toBeVisible();

  // The spurious dirty arrived through RGL effects moments after first paint, so the absence
  // check only means something after those have had time to run.
  await page.waitForTimeout(800);
  await expect(page.getByRole('button', { name: SAVE_CHANGES })).toHaveCount(0);
});

test('the default dashboard loads without Save changes', async ({ page }) => {
  await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);

  await page.goto(`${ADMIN_URL}/dashboard`);
  await expect(page).toHaveURL(/\/dashboards\//);
  // A starter-dashboard widget title, as proof the grid actually rendered.
  await expect(page.getByText('Category Overview')).toBeVisible({ timeout: 15_000 });

  // The fit-to-content passes run as each widget's fetch resolves; give the whole cascade time
  // to finish before asserting nothing marked the dashboard dirty.
  await page.waitForTimeout(1_500);
  await expect(page.getByRole('button', { name: SAVE_CHANGES })).toHaveCount(0);
});

test('a drag followed by Cancel leaves no Save changes behind', async ({ page }) => {
  await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
  gappedId ??= await createGappedDashboard(page);

  await page.goto(`${ADMIN_URL}/dashboards/${gappedId}`);
  await expect(page.getByText('Gap probe A')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Edit', exact: true }).click();

  // Drag the first widget three columns to the right, by its header (the drag handle in edit
  // mode), and prove the drag actually took before relying on it. The grab point sits low in the
  // header: the north resize handle overlays the header's top half, and grabbing there starts a
  // resize instead of a drag.
  const item = page.locator('[data-grid-item="g1"]');
  const before = (await item.boundingBox())!;
  const handle = page.locator('[data-grid-item="g1"] .widget-drag-handle');
  const hb = (await handle.boundingBox())!;
  const grabX = hb.x + 60;
  const grabY = hb.y + hb.height - 10;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(grabX + 320, grabY, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await item.boundingBox())!.x, { timeout: 5_000 })
    .toBeGreaterThan(before.x + 100);

  await page.getByRole('button', { name: 'Cancel' }).click();

  // Cancel resets the widgets to the saved layout, and the grid reports that reset through the
  // same layout-change callback as a drag — which is exactly what used to re-mark the dashboard
  // dirty right after cancelling.
  await expect.poll(async () => (await item.boundingBox())!.x, { timeout: 5_000 })
    .toBeLessThan(before.x + 50);
  await page.waitForTimeout(800);
  await expect(page.getByRole('button', { name: SAVE_CHANGES })).toHaveCount(0);

  const cleanup = await page.request.delete(`${ADMIN_URL}/api/dashboards/${gappedId}`);
  expect(cleanup.ok()).toBe(true);
});
