import { test, expect, type Page } from '@playwright/test';
import { ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD } from './fixtures';
import { signIn } from './helpers';

/**
 * Spec 014 — a mutation that fails, whether the server returns a bad response or the request
 * never reaches it at all, must surface an inline Callout. Never a silent no-op, never a raw
 * alert(). Covers every offender named in the spec: schedules-tab's toggle and run-now, and
 * dashboards-gallery's set-default/duplicate/delete/restore-starter, plus dashboard-grid-client's
 * own delete. Each handler is exercised twice: once with a non-ok response, once with a request
 * Playwright aborts outright (the rejected-fetch case the original `.ok`-only handlers could
 * never catch).
 *
 * library-client's duplicate/delete had the identical silent-no-op bug. Same contract, same test
 * shape, applied here.
 */

async function createSchedule(page: Page, name: string): Promise<string> {
  const res = await page.request.post(`${ADMIN_URL}/api/schedules`, {
    data: {
      name,
      targetType: 'all',
      recurrenceType: 'daily',
      startAt: new Date(Date.now() + 3600_000).toISOString(),
    },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json() as { id: string };
  return body.id;
}

async function createDashboard(page: Page, name: string): Promise<string> {
  const res = await page.request.post(`${ADMIN_URL}/api/dashboards`, { data: { name } });
  expect(res.ok()).toBeTruthy();
  const body = await res.json() as { id: string };
  return body.id;
}

test.describe('mutation feedback contract (spec 014)', () => {
  test('toggling a schedule surfaces an error on a bad response and on a dropped request', async ({ page }) => {
    await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
    const name = `e2e-toggle-${Date.now()}`;
    await createSchedule(page, name);

    await page.goto(`${ADMIN_URL}/scans?tab=schedules`);
    const row = page.getByRole('row', { name: new RegExp(name) });
    const toggle = row.getByRole('switch');
    await expect(toggle).toBeVisible();

    await page.route('**/api/schedules/*', route => {
      if (route.request().method() === 'PUT') return route.fulfill({ status: 500, body: JSON.stringify({ error: 'boom' }) });
      return route.continue();
    });
    await toggle.click();
    await expect(page.getByText('boom')).toBeVisible();
    await page.unroute('**/api/schedules/*');

    await page.route('**/api/schedules/*', route => {
      if (route.request().method() === 'PUT') return route.abort();
      return route.continue();
    });
    await toggle.click();
    await expect(page.getByText('Failed to update schedule')).toBeVisible();
    await page.unroute('**/api/schedules/*');
  });

  test('running a schedule now surfaces an error and re-enables the button on both failure modes', async ({ page }) => {
    await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
    const name = `e2e-runnow-${Date.now()}`;
    await createSchedule(page, name);

    await page.goto(`${ADMIN_URL}/scans?tab=schedules`);
    const row = page.getByRole('row', { name: new RegExp(name) });
    await row.hover();
    const playButton = row.getByRole('button', { name: 'Run now' });
    await expect(playButton).toBeVisible();

    await page.route('**/api/schedules/*/run', route => route.fulfill({ status: 500, body: '{}' }));
    await playButton.click();
    await expect(page.getByText('Failed to run schedule')).toBeVisible();
    await expect(playButton).toBeEnabled();
    await page.unroute('**/api/schedules/*/run');

    await page.route('**/api/schedules/*/run', route => route.abort());
    await playButton.click();
    await expect(page.getByText('Failed to run schedule')).toBeVisible();
    await expect(playButton).toBeEnabled();
    await page.unroute('**/api/schedules/*/run');
  });

  test('setting a dashboard default surfaces an error on both failure modes', async ({ page }) => {
    await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
    const name = `e2e-setdefault-${Date.now()}`;
    const id = await createDashboard(page, name);

    try {
      await page.goto(`${ADMIN_URL}/dashboards`);
      await expect(page.getByRole('link', { name })).toBeVisible();

      await page.route('**/api/dashboards/*', route => {
        if (route.request().method() === 'PUT') return route.fulfill({ status: 500, body: '{}' });
        return route.continue();
      });
      await page.getByRole('button', { name: `Actions for ${name}` }).click();
      await page.getByRole('menuitem', { name: 'Set default' }).click();
      await expect(page.getByText('Failed to set default dashboard.')).toBeVisible();
      await page.unroute('**/api/dashboards/*');

      await page.route('**/api/dashboards/*', route => {
        if (route.request().method() === 'PUT') return route.abort();
        return route.continue();
      });
      await page.getByRole('button', { name: `Actions for ${name}` }).click();
      await page.getByRole('menuitem', { name: 'Set default' }).click();
      await expect(page.getByText('Failed to set default dashboard.')).toBeVisible();
      await page.unroute('**/api/dashboards/*');
    } finally {
      await page.request.delete(`${ADMIN_URL}/api/dashboards/${id}`);
    }
  });

  test('duplicating a dashboard surfaces an error on both failure modes', async ({ page }) => {
    await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
    const name = `e2e-duplicate-${Date.now()}`;
    const id = await createDashboard(page, name);

    try {
      await page.goto(`${ADMIN_URL}/dashboards`);
      await expect(page.getByRole('link', { name })).toBeVisible();

      await page.route('**/api/dashboards/*/duplicate', route => route.fulfill({ status: 500, body: '{}' }));
      await page.getByRole('button', { name: `Actions for ${name}` }).click();
      await page.getByRole('menuitem', { name: 'Duplicate' }).click();
      await expect(page.getByText('Failed to duplicate dashboard.')).toBeVisible();
      await page.unroute('**/api/dashboards/*/duplicate');

      await page.route('**/api/dashboards/*/duplicate', route => route.abort());
      await page.getByRole('button', { name: `Actions for ${name}` }).click();
      await page.getByRole('menuitem', { name: 'Duplicate' }).click();
      await expect(page.getByText('Failed to duplicate dashboard.')).toBeVisible();
      await page.unroute('**/api/dashboards/*/duplicate');
    } finally {
      await page.request.delete(`${ADMIN_URL}/api/dashboards/${id}`);
    }
  });

  test('deleting a dashboard from the gallery surfaces an error on both failure modes', async ({ page }) => {
    await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
    const name = `e2e-delete-gallery-${Date.now()}`;
    const id = await createDashboard(page, name);
    page.on('dialog', dialog => { void dialog.accept(); });

    try {
      await page.goto(`${ADMIN_URL}/dashboards`);
      await expect(page.getByRole('link', { name })).toBeVisible();

      await page.route('**/api/dashboards/*', route => {
        if (route.request().method() === 'DELETE') return route.fulfill({ status: 500, body: '{}' });
        return route.continue();
      });
      await page.getByRole('button', { name: `Actions for ${name}` }).click();
      await page.getByRole('menuitem', { name: 'Delete' }).click();
      await expect(page.getByText('Failed to delete dashboard.')).toBeVisible();
      await expect(page.getByRole('link', { name })).toBeVisible();
      await page.unroute('**/api/dashboards/*');

      await page.route('**/api/dashboards/*', route => {
        if (route.request().method() === 'DELETE') return route.abort();
        return route.continue();
      });
      await page.getByRole('button', { name: `Actions for ${name}` }).click();
      await page.getByRole('menuitem', { name: 'Delete' }).click();
      await expect(page.getByText('Failed to delete dashboard.')).toBeVisible();
      await expect(page.getByRole('link', { name })).toBeVisible();
      await page.unroute('**/api/dashboards/*');
    } finally {
      await page.request.delete(`${ADMIN_URL}/api/dashboards/${id}`);
    }
  });

  test('restoring the starter dashboard surfaces an error and recovers the button on both failure modes', async ({ page }) => {
    await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto(`${ADMIN_URL}/dashboards`);

    // Reach the empty-state UI (the only place this handler's button renders) without deleting
    // any real dashboard: opening and cancelling the New Dashboard dialog calls refreshList(),
    // and GET /api/dashboards is intercepted to return none for that one call.
    await page.route('**/api/dashboards', route => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, body: '[]' });
      return route.continue();
    });
    await page.getByRole('button', { name: 'New Dashboard' }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.unroute('**/api/dashboards');

    const restoreButton = page.getByRole('button', { name: /Restore starter/ });
    await expect(restoreButton).toBeVisible();

    await page.route('**/api/dashboards', route => {
      if (route.request().method() === 'POST') return route.fulfill({ status: 500, body: '{}' });
      return route.continue();
    });
    await restoreButton.click();
    await expect(page.getByText('Failed to restore the starter dashboard.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restore starter' })).toBeEnabled();
    await page.unroute('**/api/dashboards');

    await page.route('**/api/dashboards', route => {
      if (route.request().method() === 'POST') return route.abort();
      return route.continue();
    });
    await restoreButton.click();
    await expect(page.getByText('Failed to restore the starter dashboard.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restore starter' })).toBeEnabled();
    await page.unroute('**/api/dashboards');
  });

  test('duplicating a rule in the Library surfaces an error on both failure modes', async ({ page }) => {
    await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
    const ruleName = `e2e-lib-dup-${Date.now()}`;

    await page.goto(`${ADMIN_URL}/library`);
    await page.getByRole('link', { name: 'New rule' }).click();
    await page.waitForURL(/\/rules\/new$/);
    await page.getByRole('button', { name: 'Resource configuration' }).click();
    await page.getByPlaceholder('e.g. Required tag: Environment').fill(ruleName);
    await page.locator('textarea.font-mono').fill('Resources\n| where tolower(name) startswith "e2e"');
    // spec 044 fixed the save-payload staleness this used to work around with a 500ms wait — Create
    // Rule now re-parses kqlText fresh for the submitted payload, not just the client-side gate, so
    // clicking immediately after typing is a real regression guard rather than a race to avoid.
    await page.getByRole('button', { name: 'Create Rule' }).click();
    await page.waitForURL(/\/library$/, { timeout: 15_000 });
    await expect(page.getByText(ruleName)).toBeVisible({ timeout: 10_000 });

    try {
      const row = page.locator('tr', { hasText: ruleName });

      await page.route('**/api/rules/*/duplicate', route => route.fulfill({ status: 500, body: JSON.stringify({ error: 'boom' }) }));
      await row.getByTitle('Duplicate as Custom').click();
      await expect(page.getByText('boom')).toBeVisible();
      await page.unroute('**/api/rules/*/duplicate');

      await page.route('**/api/rules/*/duplicate', route => route.abort());
      await row.getByTitle('Duplicate as Custom').click();
      await expect(page.getByText('Failed to duplicate rule.')).toBeVisible();
      await page.unroute('**/api/rules/*/duplicate');
    } finally {
      const row = page.locator('tr', { hasText: ruleName });
      page.once('dialog', dialog => dialog.accept());
      await row.getByTitle('Delete rule').click();
      await expect(page.getByText(ruleName)).toHaveCount(0, { timeout: 10_000 });
    }
  });

  test('deleting a rule in the Library surfaces an error on both failure modes', async ({ page }) => {
    await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
    const ruleName = `e2e-lib-del-${Date.now()}`;

    await page.goto(`${ADMIN_URL}/library`);
    await page.getByRole('link', { name: 'New rule' }).click();
    await page.waitForURL(/\/rules\/new$/);
    await page.getByRole('button', { name: 'Resource configuration' }).click();
    await page.getByPlaceholder('e.g. Required tag: Environment').fill(ruleName);
    await page.locator('textarea.font-mono').fill('Resources\n| where tolower(name) startswith "e2e"');
    // spec 044 fixed the save-payload staleness this used to work around with a 500ms wait — Create
    // Rule now re-parses kqlText fresh for the submitted payload, not just the client-side gate, so
    // clicking immediately after typing is a real regression guard rather than a race to avoid.
    await page.getByRole('button', { name: 'Create Rule' }).click();
    await page.waitForURL(/\/library$/, { timeout: 15_000 });
    await expect(page.getByText(ruleName)).toBeVisible({ timeout: 10_000 });

    try {
      const row = page.locator('tr', { hasText: ruleName });

      await page.route('**/api/rules/*', route => {
        if (route.request().method() === 'DELETE') return route.fulfill({ status: 500, body: JSON.stringify({ error: 'boom' }) });
        return route.continue();
      });
      page.once('dialog', dialog => dialog.accept());
      await row.getByTitle('Delete rule').click();
      await expect(page.getByText('boom')).toBeVisible();
      await expect(page.getByText(ruleName)).toBeVisible();
      await page.unroute('**/api/rules/*');

      await page.route('**/api/rules/*', route => {
        if (route.request().method() === 'DELETE') return route.abort();
        return route.continue();
      });
      page.once('dialog', dialog => dialog.accept());
      await row.getByTitle('Delete rule').click();
      await expect(page.getByText('Failed to delete rule.')).toBeVisible();
      await expect(page.getByText(ruleName)).toBeVisible();
      await page.unroute('**/api/rules/*');
    } finally {
      const row = page.locator('tr', { hasText: ruleName });
      page.once('dialog', dialog => dialog.accept());
      await row.getByTitle('Delete rule').click();
      await expect(page.getByText(ruleName)).toHaveCount(0, { timeout: 10_000 });
    }
  });

  test('deleting a dashboard from its own page surfaces an error on both failure modes', async ({ page }) => {
    await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
    const name = `e2e-delete-detail-${Date.now()}`;
    const id = await createDashboard(page, name);
    page.on('dialog', dialog => { void dialog.accept(); });

    try {
      await page.goto(`${ADMIN_URL}/dashboards/${id}`);

      await page.route('**/api/dashboards/*', route => {
        if (route.request().method() === 'DELETE') return route.fulfill({ status: 500, body: '{}' });
        return route.continue();
      });
      await page.getByRole('button', { name: 'More dashboard actions' }).click();
      await page.getByRole('menuitem', { name: 'Delete dashboard' }).click();
      await expect(page.getByText('Failed to delete dashboard.')).toBeVisible();
      await expect(page).toHaveURL(new RegExp(id));
      await page.unroute('**/api/dashboards/*');

      await page.route('**/api/dashboards/*', route => {
        if (route.request().method() === 'DELETE') return route.abort();
        return route.continue();
      });
      await page.getByRole('button', { name: 'More dashboard actions' }).click();
      await page.getByRole('menuitem', { name: 'Delete dashboard' }).click();
      await expect(page.getByText('Failed to delete dashboard.')).toBeVisible();
      await expect(page).toHaveURL(new RegExp(id));
      await page.unroute('**/api/dashboards/*');
    } finally {
      await page.request.delete(`${ADMIN_URL}/api/dashboards/${id}`);
    }
  });
});
