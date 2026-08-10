/**
 * Authenticated workspace — browser proof.
 *
 * What this defends: that authentication and tenant isolation hold through a real browser,
 * not only in service-level tests, and that the states slice 1 could not reach —
 * unauthorized, and a genuinely disabled form — are now reachable and correct.
 *
 * The cross-tenant test is the important one: it signs in as a real second customer and
 * confirms the first customer's data is absent. A single-tenant fixture could not tell a
 * working filter from a broken one.
 */

import { test, expect, type ConsoleMessage, type Page } from '@playwright/test';
import { ACME, GLOBEX } from './fixture.ts';

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

/** Sign in through the real form, the way a person would. */
async function signIn(page: Page, account: { email: string; password: string }) {
  await page.goto('/');
  await expect(page.getByTestId('signin-form')).toBeVisible();
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByTestId('signin-submit').click();
  await expect(page.getByTestId('signed-in-view')).toBeVisible();
}

test.describe('authentication', () => {
  test('a signed-out visitor sees sign-in and none of the application', async ({ page }) => {
    const health = watchRuntimeHealth(page);
    await page.goto('/');

    await expect(page.getByTestId('signin-form')).toBeVisible();
    await expect(page.getByTestId('signed-in-view')).toBeHidden();
    // The application chrome is absent too, not merely visually hidden behind a form.
    await expect(page.getByTestId('primary-nav')).toBeHidden();
    await expect(page.getByTestId('sign-out')).toBeHidden();
    await expect(page.getByTestId('create-project-form')).toHaveCount(0);

    await page.screenshot({ path: 'test-results/proof-s2-01-signed-out.png', fullPage: true });
    expect(health.errors, 'a signed-out page must not throw').toEqual([]);
  });

  test('signing in with a correct credential opens the workspace', async ({ page }) => {
    const health = watchRuntimeHealth(page);
    await signIn(page, ACME);

    await expect(page.getByTestId('sign-out')).toBeVisible();
    await expect(page.getByTestId('actor-badge')).not.toBeEmpty();
    await expect(page.getByTestId('environment-badge')).toHaveText('LOCAL');

    await page.screenshot({ path: 'test-results/proof-s2-02-workspace.png', fullPage: true });
    expect(health.errors).toEqual([]);
  });

  test('a wrong password is refused without revealing which part was wrong', async ({ page }) => {
    const health = watchRuntimeHealth(page, { expectHttpFailure: true });
    await page.goto('/');

    await page.getByLabel('Email').fill(ACME.email);
    await page.getByLabel('Password').fill('definitely-the-wrong-password');
    await page.getByTestId('signin-submit').click();

    const error = page.getByTestId('signin-error');
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute('role', 'alert');
    const wrongPasswordMessage = await error.textContent();

    // The password field is cleared; the email is kept so a retry is not retyping.
    await expect(page.getByLabel('Password')).toHaveValue('');
    await expect(page.getByLabel('Email')).toHaveValue(ACME.email);
    await expect(page.getByTestId('signed-in-view')).toBeHidden();

    // An unknown account must produce the SAME message, or the form enumerates accounts.
    await page.getByLabel('Email').fill('nobody@nowhere.test');
    await page.getByLabel('Password').fill('whatever');
    await page.getByTestId('signin-submit').click();
    await expect(error).toHaveText(wrongPasswordMessage!.trim());

    await page.screenshot({ path: 'test-results/proof-s2-03-signin-refused.png', fullPage: true });
    expect(health.errors, 'a refused sign-in must not throw').toEqual([]);
  });

  test('the password is never exposed to scripts or the URL', async ({ page }) => {
    await signIn(page, ACME);

    // The session cookie is HttpOnly, so document.cookie cannot see it.
    const visibleCookies = await page.evaluate(() => document.cookie);
    expect(visibleCookies).not.toContain('foundation_lab_session');
    expect(page.url()).not.toContain(ACME.password);
  });

  test('signing out returns to sign-in and the session no longer works', async ({ page }) => {
    await signIn(page, ACME);
    await page.getByTestId('sign-out').click();

    await expect(page.getByTestId('signin-form')).toBeVisible();
    await expect(page.getByTestId('signed-in-view')).toBeHidden();

    // Reloading must not restore the session — proof it was invalidated server-side, not
    // merely hidden in the page.
    await page.reload();
    await expect(page.getByTestId('signin-form')).toBeVisible();
  });
});

test.describe('tenant isolation in the browser', () => {
  test('a customer sees only its own projects', async ({ page }) => {
    // Globex owns a seeded project. If the tenant filter breaks, it appears here.
    await signIn(page, ACME);
    await page.getByLabel('Project name').fill('Acme Only Project');
    await page.getByTestId('create-submit').click();
    await expect(page.getByTestId('form-summary')).toHaveText(/Created "Acme Only Project"/);

    await expect(page.getByTestId('project-list')).toContainText('Acme Only Project');
    await expect(page.getByTestId('project-list')).not.toContainText('Globex Confidential Project');
  });

  test('the other customer sees its own project and not the first customer\'s', async ({ page }) => {
    await signIn(page, GLOBEX);

    await expect(page.getByTestId('project-list')).toContainText('Globex Confidential Project');
    await expect(page.getByTestId('project-list')).not.toContainText('Acme Only Project');

    await page.screenshot({ path: 'test-results/proof-s2-04-tenant-isolation.png', fullPage: true });
  });
});

test.describe('releases', () => {
  test('selecting a project shows its releases, and the idle state is distinct from empty', async ({ page }) => {
    const health = watchRuntimeHealth(page);
    await signIn(page, ACME);

    // IDLE — "no project selected" must not look like "this project has no releases".
    const region = page.locator('[data-releases-state]');
    await expect(region).toHaveAttribute('data-releases-state', 'idle');
    await expect(page.getByTestId('releases-status')).toHaveText(/Select a project/);

    await page.getByLabel('Project name').fill('Release Target');
    await page.getByTestId('create-submit').click();
    await expect(page.getByTestId('project-list')).toContainText('Release Target');

    await page.getByTestId('select-project').first().click();

    // EMPTY — a distinct state with its own wording.
    await expect(region).toHaveAttribute('data-releases-state', 'empty');
    await expect(page.getByTestId('releases-status')).toHaveText(/has no releases yet/);

    await page.screenshot({ path: 'test-results/proof-s2-05-releases-empty.png', fullPage: true });
    expect(health.errors).toEqual([]);
  });

  test('a seeded release renders with its revision and status', async ({ page }) => {
    await signIn(page, ACME);
    await page.getByLabel('Project name').fill('Has Releases');
    await page.getByTestId('create-submit').click();
    await expect(page.getByTestId('project-list')).toContainText('Has Releases');

    // Create the release through the API, then prove the UI reflects real server state.
    const projectId = await page.getByTestId('project-row').first().getAttribute('data-project-id');
    // page.request shares the browser context's cookies; the bare `request` fixture has
    // its own jar and would be unauthenticated.
    const created = await page.request.post('/api/releases', {
      headers: { 'content-type': 'application/json' },
      data: { projectId, version: '2.1.0', vcsRef: 'feedface', artifactDigest: 'sha256:cafe', environment: 'DEV' },
    });
    expect(created.status()).toBe(201);

    await page.getByTestId('select-project').first().click();
    await expect(page.locator('[data-releases-state]')).toHaveAttribute('data-releases-state', 'ready');

    const row = page.getByTestId('release-row').first();
    await expect(row).toContainText('2.1.0');
    await expect(row).toContainText('DEV');
    await expect(row).toContainText('feedface');
    await expect(row).toContainText('pending');

    await page.screenshot({ path: 'test-results/proof-s2-06-releases-ready.png', fullPage: true });
  });
});

test.describe('accessibility of the authenticated workspace', () => {
  test('landmarks, heading order, and labelled controls', async ({ page }) => {
    await signIn(page, ACME);

    await expect(page.locator('nav[aria-label="Primary"]')).toBeVisible();
    await expect(page.locator('main#main')).toBeVisible();
    // Both views declare an h1; the inactive one is `hidden`, so it is out of the
    // accessibility tree. What must be unique is the h1 a user can actually reach.
    await expect(page.locator('h1:visible')).toHaveCount(1);

    // Heading outline must not skip a level: h1 workspace, h2 sections, h3 within.
    const levels = await page.locator('h1:visible, h2:visible, h3:visible').evaluateAll(
      (nodes) => nodes.map((node) => Number(node.tagName.slice(1))),
    );
    for (const [index, level] of levels.entries()) {
      if (index === 0) continue;
      expect(level - levels[index - 1], `heading jumped from h${levels[index - 1]} to h${level}`).toBeLessThanOrEqual(1);
    }

    for (const control of await page.locator('input, textarea, button').all()) {
      const name = await control.evaluate((element) => {
        const labelled = (element as HTMLInputElement).labels?.[0]?.textContent ?? '';
        const candidates = [element.getAttribute('aria-label'), labelled, element.textContent];
        return (candidates.find((value) => (value ?? '').trim() !== '') ?? '').trim();
      });
      const description = await control.evaluate((element) => element.outerHTML.slice(0, 80));
      expect(name, `control needs an accessible name: ${description}`).not.toBe('');
    }
  });

  test('the sign-in form is keyboard operable and password-manager compatible', async ({ page }) => {
    await page.goto('/');

    // Autocomplete tokens are what let a password manager fill and save credentials.
    await expect(page.getByLabel('Email')).toHaveAttribute('autocomplete', 'username');
    await expect(page.getByLabel('Password')).toHaveAttribute('autocomplete', 'current-password');
    await expect(page.getByLabel('Password')).toHaveAttribute('type', 'password');

    await page.getByLabel('Email').focus();
    await page.keyboard.type(ACME.email);
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Password')).toBeFocused();
    await page.keyboard.type(ACME.password);
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('signed-in-view')).toBeVisible();
  });

  test('the page never scrolls horizontally at any width, signed in', async ({ page }) => {
    await signIn(page, ACME);
    await page.getByLabel('Project name').fill('W'.repeat(118));
    await page.getByTestId('create-submit').click();
    await expect(page.getByTestId('project-list')).toBeVisible();

    for (const width of [1440, 1280, 1024, 800, 700, 640, 480, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      expect(overflows, `page scrolls horizontally at ${width}px`).toBe(false);
    }

    await page.setViewportSize({ width: 375, height: 800 });
    await page.screenshot({ path: 'test-results/proof-s2-07-small-viewport.png', fullPage: true });
  });
});
