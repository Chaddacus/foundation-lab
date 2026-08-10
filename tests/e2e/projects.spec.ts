/**
 * Projects UI states — browser proof.
 *
 * What this defends: every applicable UI state of the Projects capability, exercised
 * through a real browser against a real server, plus the slice-1 regressions (all-zero
 * reference id, skip-link sliver, unobserved states).
 *
 * Authentication belongs to `authenticated-workspace.spec.ts`; this file signs in and then
 * concerns itself only with Projects.
 */

import { test, expect, type ConsoleMessage, type Page } from '@playwright/test';
import { ACME } from './fixture.ts';

function watchRuntimeHealth(page: Page, options: { expectHttpFailure?: boolean } = {}): { errors: string[] } {
  const errors: string[] = [];
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() !== 'error') return;
    if (options.expectHttpFailure && /Failed to load resource/.test(message.text())) return;
    errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return { errors };
}

async function listSettled(page: Page) {
  await expect(page.locator('[data-list-state]')).not.toHaveAttribute('data-list-state', 'loading');
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(ACME.email);
  await page.getByLabel('Password').fill(ACME.password);
  await page.getByTestId('signin-submit').click();
  await expect(page.getByTestId('signed-in-view')).toBeVisible();
}

test.describe('Projects UI', () => {
  test('create flow reaches READY, and the project really persisted', async ({ page }) => {
    const health = watchRuntimeHealth(page);
    await signIn(page);
    await listSettled(page);

    await page.getByLabel('Project name').fill('Apollo');
    await page.getByLabel(/Description/).fill('Lunar programme');
    await page.getByTestId('create-submit').click();

    await expect(page.getByTestId('form-summary')).toHaveText(/Created "Apollo"/);
    await expect(page.getByTestId('project-row').first()).toContainText('Apollo');
    await expect(page.getByTestId('project-row').first()).toContainText('active');

    // Form cleared and focus returned, so a second entry is immediate.
    await expect(page.getByLabel('Project name')).toHaveValue('');
    await expect(page.getByLabel('Project name')).toBeFocused();

    // Independent confirmation of server-side state, not an optimistic render.
    await page.reload();
    await expect(page.getByTestId('project-list')).toContainText('Apollo');
    // page.request shares the browser context's cookies, so this read is authenticated
    // as the same user rather than anonymous.
    const { data } = await (await page.request.get('/api/projects')).json();
    expect(data.some((project: { name: string }) => project.name === 'Apollo')).toBe(true);

    await page.screenshot({ path: 'test-results/proof-s2-08-projects-ready.png', fullPage: true });
    expect(health.errors, 'runtime must be clean').toEqual([]);
  });

  test('the create form has no customer field — ownership is not a client input', async ({ page }) => {
    await signIn(page);
    // Regression against mass assignment: if a customer field ever reappears in the form,
    // someone has moved ownership back under client control.
    await expect(page.locator('[name="customerId"]')).toHaveCount(0);
  });

  test('LOADING state is actually entered, not merely exited', async ({ page }) => {
    await signIn(page);

    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/projects', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await held;
      await route.continue();
    });

    await page.reload();
    const region = page.locator('[data-list-state]');
    await expect(region).toHaveAttribute('data-list-state', 'loading');
    await expect(region).toHaveAttribute('aria-busy', 'true');

    release();
    await expect(region).not.toHaveAttribute('data-list-state', 'loading');
    await expect(region).toHaveAttribute('aria-busy', 'false');
  });

  test('SUBMITTING state disables the control and makes a double submit impossible', async ({ page }) => {
    await signIn(page);
    await listSettled(page);

    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let createCalls = 0;

    await page.route('**/api/projects', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      createCalls += 1;
      await held;
      await route.continue();
    });

    await page.getByLabel('Project name').fill('Slow create');
    const submit = page.getByTestId('create-submit');
    await submit.click();

    await expect(submit).toBeDisabled();
    await expect(submit).toHaveAttribute('aria-busy', 'true');
    await expect(submit).toHaveText('Creating…');

    await submit.click({ force: true });
    release();

    await expect(page.getByTestId('form-summary')).toHaveText(/Created "Slow create"/);
    expect(createCalls, 'a double submit must not create twice').toBe(1);
  });

  test('ERROR state: server validation is shown per field, announced, and carries no fake reference', async ({ page }) => {
    const health = watchRuntimeHealth(page, { expectHttpFailure: true });
    await signIn(page);
    await listSettled(page);

    // `novalidate` lets the request reach the server, so this proves the SERVER's rules
    // surface in the UI rather than the browser's built-in check.
    await page.getByTestId('create-submit').click();

    await expect(page.getByTestId('error-name')).toHaveText('Enter a project name.');
    await expect(page.getByLabel('Project name')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel('Project name')).toBeFocused();

    const describedBy = await page.getByLabel('Project name').getAttribute('aria-describedby');
    expect(describedBy).toContain('project-name-error');

    const summary = page.getByTestId('form-summary');
    await expect(summary).toHaveAttribute('role', 'alert');
    // Regression: the all-zero OTel trace id was displayed as a real support reference.
    await expect(summary).not.toContainText(/0{16}/);

    await page.screenshot({ path: 'test-results/proof-s2-09-validation-error.png', fullPage: true });
    expect(health.errors, 'a validation failure must not throw').toEqual([]);
  });

  test('UNAVAILABLE state: a dead backend is explained, not shown as an empty list', async ({ page }) => {
    await signIn(page);
    await page.route('**/api/projects', (route) => route.abort('failed'));
    await page.reload();

    await expect(page.locator('[data-list-state]')).toHaveAttribute('data-list-state', 'unavailable');
    await expect(page.getByTestId('list-status')).toHaveText(/unreachable/i);
    await expect(page.getByTestId('list-status')).toHaveAttribute('role', 'status');

    await page.screenshot({ path: 'test-results/proof-s2-10-unavailable.png', fullPage: true });
  });

  test('UNAUTHORIZED state: the create form is disabled rather than inviting a doomed submit', async ({ page }) => {
    await signIn(page);
    await page.route('**/api/projects', (route) => route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { kind: 'unauthorized', message: 'Sign in to continue.', reference: '' } }),
    }));
    await page.reload();

    await expect(page.locator('[data-list-state]')).toHaveAttribute('data-list-state', 'unauthorized');
    await expect(page.getByTestId('create-fieldset')).toHaveAttribute('disabled', '');
    await expect(page.getByTestId('create-submit')).toBeDisabled();
    await expect(page.getByLabel('Project name')).toBeDisabled();
    await expect(page.getByTestId('form-blocked')).toHaveText(/cannot create a project/);

    await page.screenshot({ path: 'test-results/proof-s2-11-unauthorized.png', fullPage: true });
  });

  test('a server failure is reported with its real trace reference', async ({ page }) => {
    await signIn(page);
    await page.route('**/api/projects', (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { kind: 'internal', message: 'Projects could not be loaded.', reference: 'trace-1234' } }),
    }));
    await page.reload();

    await expect(page.getByTestId('list-status')).toContainText('trace-1234');
  });

  test('the list is announced as a status, not by reading out the whole table', async ({ page }) => {
    await signIn(page);
    await listSettled(page);

    await expect(page.getByTestId('list-status')).toHaveAttribute('role', 'status');
    await expect(page.getByTestId('project-list-region')).not.toHaveAttribute('aria-live', /.*/);
    await expect(page.getByTestId('project-list-content')).not.toHaveAttribute('aria-live', /.*/);
  });

  test('the table carries the semantics assistive technology needs', async ({ page }) => {
    await signIn(page);
    await page.getByLabel('Project name').fill('Semantics');
    await page.getByTestId('create-submit').click();
    await expect(page.getByTestId('project-list')).toBeVisible();

    await expect(page.locator('.data-table caption').first()).toHaveText(/Projects, newest first/);
    await expect(page.locator('[data-testid="project-list"] thead th[scope="col"]')).toHaveCount(4);
    await expect(page.locator('[data-testid="project-list"] tbody th[scope="row"]').first()).toBeVisible();
  });

  test('the skip link is clipped when unfocused and visible when focused', async ({ page }) => {
    await signIn(page);

    // Regression: a negative-offset variant left a visible sliver over the header.
    const skipLink = page.locator('.skip-link');
    expect((await skipLink.boundingBox())!.height).toBeLessThanOrEqual(2);

    // Sign-in leaves focus inside the page, and blurring does not reset the browser's
    // sequential focus starting point. A reload gives a fresh document with the session
    // intact — the same state a returning visitor lands in.
    await page.reload();
    await expect(page.getByTestId('signed-in-view')).toBeVisible();

    await page.keyboard.press('Tab');
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeVisible();
    expect((await skipLink.boundingBox())!.height).toBeGreaterThan(20);
  });

  test('target sizes meet the WCAG 2.2 minimum and focus is visible', async ({ page }) => {
    await signIn(page);
    await listSettled(page);

    for (const control of await page.locator('button, input, textarea').all()) {
      const box = await control.boundingBox();
      if (box === null) continue;
      expect(box.height, 'target height').toBeGreaterThanOrEqual(24);
      expect(box.width, 'target width').toBeGreaterThanOrEqual(24);
    }

    const outlineWidth = await page.getByTestId('create-submit').evaluate((element) => {
      element.focus();
      return getComputedStyle(element).outlineWidth;
    });
    expect(parseFloat(outlineWidth)).toBeGreaterThan(0);
  });
});
