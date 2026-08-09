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
    await expect(page.getByTestId('list-status')).toHaveAttribute('role', 'status');
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

  test('LOADING state is actually entered, not merely exited', async ({ page }) => {
    // Previously only "not loading" was asserted, so deleting the loading state entirely
    // still passed. This holds the response open and observes the state while it is live.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/projects', async (route) => { await held; await route.continue(); });

    await page.goto('/');
    const region = page.locator('[data-list-state]');
    await expect(region).toHaveAttribute('data-list-state', 'loading');
    await expect(region).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByTestId('list-status')).toHaveText(/Loading projects/);

    release();
    await expect(region).not.toHaveAttribute('data-list-state', 'loading');
    await expect(region).toHaveAttribute('aria-busy', 'false');
  });

  test('SUBMITTING state disables the control and makes a double submit impossible', async ({ page }) => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let createCalls = 0;

    await page.route('**/api/projects', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      createCalls += 1;
      await held;
      await route.continue();
    });

    await page.goto('/');
    await listSettled(page);
    await page.getByLabel('Project name').fill('Slow create');
    await page.getByLabel('Customer id').fill('cust-slow');

    const submit = page.getByTestId('create-submit');
    await submit.click();

    // The state is observable while the request is in flight.
    await expect(submit).toBeDisabled();
    await expect(submit).toHaveAttribute('aria-busy', 'true');
    await expect(submit).toHaveText('Creating…');
    await page.screenshot({ path: 'test-results/proof-06-submitting.png', fullPage: true });

    // A second click during flight must not produce a second create.
    await submit.click({ force: true });
    release();

    await expect(page.getByTestId('form-summary')).toHaveText(/Created "Slow create"/);
    await expect(submit).toBeEnabled();
    expect(createCalls, 'a double submit must not create twice').toBe(1);
  });

  test('the list is announced as a status, not by reading out the whole table', async ({ page }) => {
    await page.goto('/');
    await listSettled(page);

    // The live region is the status line only. It previously wrapped the table, so every
    // create re-announced every row and cell.
    const status = page.getByTestId('list-status');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(page.getByTestId('project-list-region')).not.toHaveAttribute('aria-live', /.*/);
    await expect(page.getByTestId('project-list-content')).not.toHaveAttribute('aria-live', /.*/);
  });

  test('the table carries the semantics assistive technology needs', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Project name').fill('Semantics');
    await page.getByLabel('Customer id').fill('cust-sem');
    await page.getByTestId('create-submit').click();
    await expect(page.getByTestId('project-list')).toBeVisible();

    await expect(page.locator('.projects-table caption')).toHaveText(/Projects, newest first/);
    await expect(page.locator('.projects-table thead th[scope="col"]')).toHaveCount(4);
    await expect(page.locator('.projects-table tbody th[scope="row"]').first()).toBeVisible();

    // The shell's heading must survive the module's render: it names the region.
    await expect(page.locator('#projects-heading')).toHaveCount(1);
    const levels = await page.locator('h1, h2, h3').evaluateAll(
      (nodes) => nodes.map((node) => Number(node.tagName.slice(1))),
    );
    expect(levels, 'heading outline must not skip a level').toEqual([1, 2, 3, 3]);
  });

  test('UNAUTHORIZED state disables the create form instead of inviting a doomed submit', async ({ page }) => {
    await page.route('**/api/projects', (route) => route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { kind: 'unauthorized', message: 'Not signed in.', reference: '' } }),
    }));
    await page.goto('/');

    await expect(page.locator('[data-list-state]')).toHaveAttribute('data-list-state', 'unauthorized');

    // Assert the controls the user actually reaches. Playwright does not report a
    // <fieldset> itself as disabled, so checking the fieldset alone would prove nothing —
    // its descendants are where the effect is observable.
    await expect(page.getByTestId('create-fieldset')).toHaveAttribute('disabled', '');
    await expect(page.getByTestId('create-submit')).toBeDisabled();
    await expect(page.getByLabel('Project name')).toBeDisabled();
    await expect(page.getByLabel('Customer id')).toBeDisabled();
    await expect(page.getByLabel(/Description/)).toBeDisabled();
    await expect(page.getByTestId('form-blocked')).toHaveText(/cannot create a project/);
    await page.screenshot({ path: 'test-results/proof-07-unauthorized.png', fullPage: true });
  });

  test('a long project name does not push the document sideways at any width', async ({ page }) => {
    // Regression: the scroll container was scoped to <= 640px, so a long name the app's own
    // 120-character limit permits scrolled the whole page at every desktop width.
    await page.goto('/');
    await listSettled(page);
    await page.getByLabel('Project name').fill('A'.repeat(118));
    await page.getByLabel('Customer id').fill('C'.repeat(40));
    await page.getByTestId('create-submit').click();
    await expect(page.getByTestId('project-list')).toBeVisible();

    for (const width of [1440, 1280, 1024, 800, 700, 640, 480, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      expect(overflows, `page scrolls horizontally at ${width}px`).toBe(false);
    }

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: 'test-results/proof-08-long-name-desktop.png', fullPage: true });
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
