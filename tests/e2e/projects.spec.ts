/**
 * Projects UI — browser proof.
 *
 * What this defends: that the Projects capability actually works through a real browser —
 * every UI state the capability checklist marks applicable is reachable and correct, the
 * page is keyboard operable, and the runtime is clean.
 *
 * Console and network health are asserted, not just appearance: a page that renders while
 * throwing is not working. Screenshots are captured for the states where appearance
 * matters, and are inspected as part of the evidence — their existence proves nothing.
 */

import { test, expect, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * Collect runtime health problems.
 *
 * Attached before navigation so nothing thrown during page load is missed.
 *
 * `expectHttpFailure` exists because Chrome logs its own console error for any non-2xx
 * response. When a test deliberately provokes a 400, that browser-generated line is not an
 * application fault. Uncaught exceptions (`pageerror`) are ALWAYS fatal and are never
 * filtered — the allowance narrows what is observed, it does not weaken it.
 */
function watchRuntimeHealth(page: Page, options: { expectHttpFailure?: boolean } = {}): { errors: string[] } {
  const errors: string[] = [];
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() !== 'error') return;
    const isBrowserResourceLog = /Failed to load resource/.test(message.text());
    if (options.expectHttpFailure && isBrowserResourceLog) return;
    errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return { errors };
}

/** Wait until the list region has settled out of its loading state. */
async function listSettled(page: Page) {
  await expect(page.locator('[data-list-state]')).not.toHaveAttribute('data-list-state', 'loading');
}

test.describe('Projects UI', () => {
  test('empty state, create flow, and ready state work end to end', async ({ page }) => {
    const health = watchRuntimeHealth(page);
    await page.goto('/');

    // EMPTY — a fresh database shows guidance, not a bare page or a spinner that never ends.
    await expect(page.locator('[data-list-state]')).toHaveAttribute('data-list-state', 'empty');
    await expect(page.getByTestId('list-status')).toHaveText(/No projects yet/);
    await page.screenshot({ path: 'test-results/proof-01-empty.png', fullPage: true });

    // SUBMITTING → SUCCESS — the real capability, driven the way a person would.
    await page.getByLabel('Project name').fill('Apollo');
    await page.getByLabel('Customer id').fill('cust-1');
    await page.getByLabel(/Description/).fill('Lunar programme');
    await page.getByTestId('create-submit').click();

    await expect(page.getByTestId('form-summary')).toHaveText(/Created "Apollo"/);

    // READY — the created project is listed with its real stored values.
    const row = page.getByTestId('project-row').first();
    await expect(row).toContainText('Apollo');
    await expect(row).toContainText('cust-1');
    await expect(row).toContainText('active');
    await page.screenshot({ path: 'test-results/proof-02-ready.png', fullPage: true });

    // The form is cleared and focus returns to the first field, so a second entry is immediate.
    await expect(page.getByLabel('Project name')).toHaveValue('');
    await expect(page.getByLabel('Project name')).toBeFocused();

    expect(health.errors, 'runtime must be clean').toEqual([]);
  });

  test('the created project really persisted, not just rendered optimistically', async ({ page, request }) => {
    await page.goto('/');
    await page.getByLabel('Project name').fill('Persisted');
    await page.getByLabel('Customer id').fill('cust-2');
    await page.getByTestId('create-submit').click();
    await expect(page.getByTestId('form-summary')).toHaveText(/Created/);

    // Independent read: reload proves it survived, and the API confirms server-side state.
    await page.reload();
    await expect(page.getByTestId('project-list')).toContainText('Persisted');

    const { data } = await (await request.get('/api/projects')).json();
    expect(data.some((project: { name: string }) => project.name === 'Persisted')).toBe(true);
  });

  test('ERROR state: server validation is shown per field and announced', async ({ page }) => {
    const health = watchRuntimeHealth(page, { expectHttpFailure: true });
    await page.goto('/');
    await listSettled(page);

    // Submit with an empty customer id. `novalidate` lets the request reach the server, so
    // this proves the server's rules surface in the UI — not the browser's built-in check.
    await page.getByLabel('Project name').fill('No customer');
    await page.getByTestId('create-submit').click();

    await expect(page.getByTestId('error-customerId')).toHaveText('A project must belong to a customer.');
    await expect(page.getByLabel('Customer id')).toHaveAttribute('aria-invalid', 'true');

    // The error is programmatically associated with its field, so it is announced, not just drawn.
    const describedBy = await page.getByLabel('Customer id').getAttribute('aria-describedby');
    expect(describedBy).toContain('project-customer-error');

    // Focus moves to the first failing field so a keyboard user is not stranded.
    await expect(page.getByLabel('Customer id')).toBeFocused();

    // The summary is a live region.
    await expect(page.getByTestId('form-summary')).toHaveAttribute('role', 'alert');

    // Regression: telemetry is off in this run, so there is no usable trace. The interface
    // must omit the reference rather than print the all-zero trace id as though it were real.
    await expect(page.getByTestId('form-summary')).not.toContainText(/0{16}/);

    await page.screenshot({ path: 'test-results/proof-03-validation-error.png', fullPage: true });
    expect(health.errors, 'a validation failure must not throw').toEqual([]);
  });

  test('UNAVAILABLE state: the UI explains a dead backend instead of showing an empty list', async ({ page }) => {
    await page.route('**/api/projects', (route) => route.abort('failed'));
    await page.goto('/');

    await expect(page.getByTestId('list-status')).toHaveText(/unreachable/i);
    await expect(page.getByTestId('list-status')).toHaveAttribute('role', 'alert');
    await page.screenshot({ path: 'test-results/proof-04-unavailable.png', fullPage: true });
  });

  test('ERROR state: a server failure is reported with its trace reference', async ({ page }) => {
    await page.route('**/api/projects', (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { kind: 'internal', message: 'Projects could not be loaded.', reference: 'trace-1234' } }),
    }));
    await page.goto('/');

    await expect(page.getByTestId('list-status')).toContainText('trace-1234');
  });

  test('deployment identity is reported honestly, never guessed', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('environment-badge')).toHaveText('LOCAL');
    await expect(page.getByTestId('environment-badge')).toHaveAttribute('title', /revision e2e-local/);
  });

  test('the create flow is fully keyboard operable with visible focus', async ({ page }) => {
    await page.goto('/');
    await listSettled(page);

    // Tab order: skip link → nav → name → customer → description → submit.
    // The skip link must be clipped when unfocused — a negative-offset variant left a
    // visible sliver over the header — and fully visible once focused.
    const skipLink = page.locator('.skip-link');
    expect((await skipLink.boundingBox())!.height).toBeLessThanOrEqual(2);

    await page.keyboard.press('Tab');
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeVisible();
    expect((await skipLink.boundingBox())!.height).toBeGreaterThan(20);

    await page.getByLabel('Project name').focus();
    await page.keyboard.type('Keyboard Only');
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Customer id')).toBeFocused();
    await page.keyboard.type('cust-kbd');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('create-submit')).toBeFocused();

    // Focus must be visible, not merely present.
    const outlineWidth = await page.getByTestId('create-submit').evaluate(
      (element) => getComputedStyle(element).outlineWidth,
    );
    expect(parseFloat(outlineWidth)).toBeGreaterThan(0);

    await page.keyboard.press('Enter');
    await expect(page.getByTestId('form-summary')).toHaveText(/Created "Keyboard Only"/);
  });

  test('accessibility structure: landmarks, one h1, labelled controls, adequate targets', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('header')).toBeVisible();
    await expect(page.locator('nav[aria-label="Primary"]')).toBeVisible();
    await expect(page.locator('main#main')).toBeVisible();
    await expect(page.locator('h1')).toHaveCount(1);

    // Every control has an accessible name — the check that catches an unlabelled input.
    // Buttons take their name from their content; inputs and textareas from their label.
    for (const control of await page.locator('input, textarea, button').all()) {
      const name = await control.evaluate((element) => {
        const labelled = (element as HTMLInputElement).labels?.[0]?.textContent ?? '';
        const candidates = [element.getAttribute('aria-label'), labelled, element.textContent];
        return (candidates.find((value) => (value ?? '').trim() !== '') ?? '').trim();
      });
      const description = await control.evaluate((element) => element.outerHTML.slice(0, 80));
      expect(name, `control needs an accessible name: ${description}`).not.toBe('');
    }

    // WCAG 2.2 target size (2.5.8): 24px minimum.
    for (const control of await page.locator('button, input, textarea').all()) {
      const box = await control.boundingBox();
      expect(box!.height, 'target height').toBeGreaterThanOrEqual(24);
    }
  });

  test('the layout does not break at a small viewport and hides no capability', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Project name').fill('Small screen');
    await page.getByLabel('Customer id').fill('cust-3');
    await page.getByTestId('create-submit').click();
    await expect(page.getByTestId('project-list')).toBeVisible();

    await page.setViewportSize({ width: 375, height: 720 });

    // The create form and the list both remain reachable at mobile width.
    await expect(page.getByTestId('create-project-form')).toBeVisible();
    await expect(page.getByTestId('project-list')).toBeVisible();

    // The page itself must not scroll sideways; the wide table scrolls inside its own box.
    const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflows, 'page must not scroll horizontally').toBe(false);

    await page.screenshot({ path: 'test-results/proof-05-small-viewport.png', fullPage: true });
  });
});
