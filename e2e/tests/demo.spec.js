import { expect, test } from '@playwright/test';

// End-to-end walk through the UI: reset the demo, run scenarios, check the
// overview, reconcile view and CSV export. Uses the real API and databases.
test.describe.serial('ReconcileOps demo', () => {
  test('reset demo data', async ({ page }) => {
    await page.goto('/demo');
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Reset demo data' }).click();
    await expect(page.getByText('Demo services recreated')).toBeVisible();
  });

  test('baseline step succeeds in every environment', async ({ page }) => {
    await page.goto('/demo');
    const step = page.locator('li.step', { hasText: 'Baseline: create products' });
    await step.getByRole('button', { name: 'Run step' }).click();
    await expect(step.locator('.step-results li.pass')).toHaveCount(4);
  });

  test('incompatible rename is refused', async ({ page }) => {
    await page.goto('/demo');
    for (const title of ['Expand: add price_cents', 'Deploy app v2.0', 'Incompatible: direct column rename']) {
      const step = page.locator('li.step', { hasText: title });
      await step.getByRole('button', { name: 'Run step' }).click();
      await expect(step.locator('.step-results')).toBeVisible();
    }
    const rename = page.locator('li.step', { hasText: 'Incompatible: direct column rename' });
    await expect(rename.locator('.step-results li.fail')).toContainText('1 error(s)');
  });

  test('failed migration is recorded and health rollback works', async ({ page }) => {
    await page.goto('/demo');
    for (const title of ['Baseline + concurrent index', 'Failed migration (bad data)', 'Recover: retire V3', 'Health check triggers rollback']) {
      const step = page.locator('li.step', { hasText: title });
      await step.getByRole('button', { name: 'Run step' }).click();
      await expect(step.locator('.step-results')).toBeVisible();
    }
    await expect(page.locator('li.step', { hasText: 'Failed migration (bad data)' })).toContainText('violated by some row');
    await expect(page.locator('li.step', { hasText: 'Health check triggers rollback' })).toContainText('Rolled back');
  });

  test('overview shows the services and metrics', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Product Service' })).toBeVisible();
    await expect(page.getByText('Success rate')).toBeVisible();
    await expect(page.getByLabel('development: healthy').first()).toBeVisible();
  });

  test('a script can be written, validated and run from the UI', async ({ page }) => {
    await page.goto('/projects');
    await page.getByRole('link', { name: /Order Service/ }).click();
    await page.getByRole('tab', { name: 'Migration scripts' }).click();

    // V5 was rolled back by its health check, so it is still pending and
    // would block anything newer until someone rejects it.
    const v5 = page.locator('tr', { hasText: 'Tool-generated cleanup' });
    await v5.getByRole('button', { name: 'Reject' }).click();
    await expect(v5.getByText('Rejected')).toBeVisible();

    await page.getByRole('button', { name: 'New script' }).click();
    await page.getByLabel('Version').fill('6');
    await page.getByLabel('Description').fill('Add shipping note');
    await page.getByLabel('Up script').fill('ALTER TABLE orders ADD COLUMN shipping_note TEXT;');
    await page.getByLabel('Down script').fill('ALTER TABLE orders DROP COLUMN shipping_note;');
    await page.getByRole('button', { name: 'Save as draft' }).click();

    const row = page.locator('tr', { hasText: 'Add shipping note' });
    await row.getByRole('button', { name: 'Validate' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Validate' }).click();
    await expect(page.getByText(/^Passed/)).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();

    await row.getByRole('button', { name: 'Run' }).click();
    await expect(page.getByText('Pre-flight checks pass')).toBeVisible();
    await page.getByRole('button', { name: 'Run on development' }).click();
    await expect(page.getByRole('dialog').locator('.verdict-line .badge')).toHaveText('Succeeded');
  });

  test('reconcile shows staging as pending', async ({ page }) => {
    await page.goto('/reconcile');
    await page.getByRole('button', { name: 'staging' }).click();
    await expect(page.locator('.state-banner h2')).toHaveText(/Changes pending|In sync|Drift detected|Blocked/);
  });

  test('reports export a CSV', async ({ page }) => {
    await page.goto('/reports');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export runs as CSV' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^reconcileops-runs-.*\.csv$/);
  });
});
