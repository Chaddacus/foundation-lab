/**
 * Project archive — browser proof.
 *
 * What this defends: that an irreversible action carries proportional friction, states its
 * consequence before it happens, and that an archived project is visibly and functionally
 * closed afterwards.
 *
 * The confirmation is the point. Creating a project is reversible and asks nothing;
 * archiving cannot be undone, so a bare click must not be enough.
 */

import { test, expect, type Page } from '@playwright/test';
import { ACME } from './fixture.ts';

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(ACME.email);
  await page.getByLabel('Password').fill(ACME.password);
  await page.getByTestId('signin-submit').click();
  await expect(page.getByTestId('signed-in-view')).toBeVisible();
}

async function createProject(page: Page, name: string) {
  await page.getByLabel('Project name').fill(name);
  await page.getByTestId('create-submit').click();
  await expect(page.getByTestId('form-summary')).toHaveText(new RegExp(`Created "${name}"`));
}

/** The row for a named project, so tests do not depend on list ordering. */
function rowFor(page: Page, name: string) {
  return page.getByTestId('project-row').filter({ hasText: name });
}

test.describe('archiving a project', () => {
  test('the confirmation names the project and states the consequence', async ({ page }) => {
    await signIn(page);
    await createProject(page, 'Needs confirming');

    let message = '';
    page.on('dialog', (dialog) => { message = dialog.message(); void dialog.dismiss(); });
    await rowFor(page, 'Needs confirming').getByTestId('archive-project').click();

    // Not a bare "are you sure" — that trains people to click through.
    expect(message).toContain('Needs confirming');
    expect(message).toContain('can no longer be edited');
    expect(message).toContain('cannot be undone');
  });

  test('dismissing the confirmation changes nothing', async ({ page }) => {
    await signIn(page);
    await createProject(page, 'Not archived');

    page.on('dialog', (dialog) => void dialog.dismiss());
    await rowFor(page, 'Not archived').getByTestId('archive-project').click();

    // The row must still say active, and the button must still be offered.
    await expect(rowFor(page, 'Not archived')).toContainText('active');
    await expect(rowFor(page, 'Not archived').getByTestId('archive-project')).toBeVisible();
  });

  test('accepting archives the project and the change persists', async ({ page }) => {
    await signIn(page);
    await createProject(page, 'Will archive');

    page.on('dialog', (dialog) => void dialog.accept());
    await rowFor(page, 'Will archive').getByTestId('archive-project').click();

    await expect(page.getByTestId('form-summary')).toHaveText(/Archived "Will archive"/);
    await expect(rowFor(page, 'Will archive')).toContainText('archived');

    // Independent confirmation of server state rather than an optimistic render.
    await page.reload();
    await expect(rowFor(page, 'Will archive')).toContainText('archived');
  });

  test('an archived project offers no archive control and is not hidden from the list', async ({ page }) => {
    await signIn(page);
    await createProject(page, 'Already archived');

    page.on('dialog', (dialog) => void dialog.accept());
    await rowFor(page, 'Already archived').getByTestId('archive-project').click();
    await expect(page.getByTestId('form-summary')).toHaveText(/Archived/);

    const row = rowFor(page, 'Already archived');
    await expect(row.getByTestId('archive-project')).toHaveCount(0);
    await expect(row.getByTestId('archive-unavailable')).toBeVisible();
    // Archived is not deleted: the record remains the customer's and stays visible.
    await expect(row).toBeVisible();
  });

  test('a refused archive explains why and leaves the control usable', async ({ page }) => {
    await signIn(page);
    await createProject(page, 'Conflicting');

    await page.route('**/archive', (route) => route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: { kind: 'conflict', message: 'This project is already archived.', reference: '' } }),
    }));

    page.on('dialog', (dialog) => void dialog.accept());
    const button = rowFor(page, 'Conflicting').getByTestId('archive-project');
    await button.click();

    await expect(page.getByTestId('form-summary')).toContainText('already archived');
    // The control returns to a usable state rather than being left disabled mid-action.
    await expect(button).toBeEnabled();
  });

  test('the archive control is keyboard reachable and adequately sized', async ({ page }) => {
    await signIn(page);
    await createProject(page, 'Keyboard archive');

    const button = rowFor(page, 'Keyboard archive').getByTestId('archive-project');
    await button.focus();
    await expect(button).toBeFocused();

    const box = await button.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(24);
    expect(box!.width).toBeGreaterThanOrEqual(24);

    // Its accessible name identifies WHICH project, so a screen-reader user is not choosing
    // between several identically-named "Archive" buttons.
    const name = await button.evaluate((element) => element.textContent?.trim());
    expect(name).toContain('Keyboard archive');
  });

  test('the page still does not scroll sideways with the extra column', async ({ page }) => {
    await signIn(page);
    await createProject(page, 'W'.repeat(100));

    for (const width of [1280, 800, 640, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const scrolled = await page.evaluate(() => {
        window.scrollTo(500, 0);
        const x = window.scrollX;
        window.scrollTo(0, 0);
        return x;
      });
      expect(scrolled, `page scrolls sideways at ${width}px`).toBe(0);
    }

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: 'test-results/proof-s4-01-archive.png', fullPage: true });
  });
});
