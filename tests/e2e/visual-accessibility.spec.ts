/**
 * Visual and accessibility properties a design pass can break — browser proof.
 *
 * Why this file exists: a design pass changed colours, a focus ring, a sticky header, hover
 * states and the base font size, and the entire existing suite passed unchanged before and
 * after. That was taken as evidence the change was safe. It was not — it was evidence about
 * the suite. Independent review found a focused skip link completely hidden behind the new
 * header, badge text below AA contrast on the new hover background, and a fixed pixel body
 * size that ignored the reader's font-size setting. Nothing here could see any of them.
 *
 * Every assertion below observes something no other test in the suite can:
 *   - OCCLUSION, which `toBeVisible()` and a bounding box cannot detect
 *   - CONTRAST as a computed ratio against the surface actually behind the text
 *   - the response to a reader's own root font size
 *   - forced-colours rendering, where backgrounds and shadows are stripped
 */

import { test, expect, type Page } from '@playwright/test';
import { ACME } from './fixture.ts';

/** WCAG relative luminance and contrast ratio, computed rather than eyeballed. */
function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const luminance = (rgb: [number, number, number]) => {
    const [r, g, bl] = rgb.map((channel) => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

function parseRgb(value: string): [number, number, number] {
  const parts = value.match(/\d+(\.\d+)?/g);
  if (parts === null) throw new Error(`cannot parse colour: ${value}`);
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(ACME.email);
  await page.getByLabel('Password').fill(ACME.password);
  await page.getByTestId('signin-submit').click();
  await expect(page.getByTestId('signed-in-view')).toBeVisible();
}

test.describe('focus is not obscured (WCAG 2.2 AA 2.4.11)', () => {
  test('the focused skip link is actually painted, not merely present', async ({ page }) => {
    // Regression: a sticky header with a higher z-index covered it completely. It remained
    // "visible" to Playwright and had a full bounding box — 0 of 9 sample points were
    // actually the link, and elementFromPoint returned the brand mark.
    // Signed in and reloaded: the signed-out view autofocuses the email field, so the skip
    // link is only genuinely the first tab stop here — which is also the page that has a
    // sticky header and content worth skipping.
    await signIn(page);
    await page.reload();
    await expect(page.getByTestId('signed-in-view')).toBeVisible();
    await page.keyboard.press('Tab');

    const result = await page.evaluate(() => {
      const link = document.querySelector('.skip-link') as HTMLElement;
      const box = link.getBoundingClientRect();
      let painted = 0;
      for (const fx of [0.15, 0.5, 0.85]) {
        for (const fy of [0.2, 0.5, 0.8]) {
          const top = document.elementFromPoint(box.left + box.width * fx, box.top + box.height * fy);
          if (top === link || link.contains(top)) painted += 1;
        }
      }
      return { focused: document.activeElement === link, painted };
    });

    expect(result.focused, 'the skip link should be the first tab stop').toBe(true);
    expect(result.painted, 'the focused skip link is covered by something').toBe(9);
  });

  /*
   * NOT TESTED: that `scroll-padding-block-start` keeps a focused control clear of the
   * sticky header when the page scrolls.
   *
   * An assertion was written for it and removed. Under mutation — deleting the
   * scroll-padding — it still passed, because no page in the fixture is long enough to
   * scroll and Chromium's scroll-into-view already clears the header. A test that cannot
   * fail is worse than no test, because it is trusted. The padding is still set; it is
   * simply not defended, and that is recorded here rather than implied by a green result.
   *
   * Partial occlusion passes WCAG 2.4.11 Minimum, so this is a nicety rather than the AA
   * criterion the assertion above defends.
   */
});

test.describe('contrast is a property of the pair, not of the colour', () => {
  test('badge text clears AA against the row background it is hovered on', async ({ page }) => {
    // Regression: adding a row-hover background put success and warning badges at 4.50 and
    // 4.37 against it. Both had been fine on white. Introducing a surface changes what the
    // foreground is allowed to be.
    await signIn(page);
    await page.getByLabel('Project name').fill('Contrast subject');
    await page.getByTestId('create-submit').click();
    await expect(page.getByTestId('project-list')).toBeVisible();

    const row = page.getByTestId('project-row').first();
    await row.hover();

    const measured = await row.evaluate((element) => {
      const badge = element.querySelector('.badge') as HTMLElement;
      return {
        text: getComputedStyle(badge).color,
        // The badge sets no background, so the row's is what sits behind the text.
        surface: getComputedStyle(element).backgroundColor,
        fontSize: parseFloat(getComputedStyle(badge).fontSize),
      };
    });

    const ratio = contrastRatio(parseRgb(measured.text), parseRgb(measured.surface));
    // Small text: AA is 4.5:1. These badges are ~12.8px, well under the large-text threshold.
    expect(measured.fontSize).toBeLessThan(18.66);
    expect(ratio, `badge text is ${ratio.toFixed(2)}:1 on the hovered row`).toBeGreaterThanOrEqual(4.5);
  });

  test('every status badge colour clears AA on both the plain and hovered row', async ({ page }) => {
    await signIn(page);

    const ratios = await page.evaluate(() => {
      const styles = getComputedStyle(document.documentElement);
      const probe = document.createElement('span');
      document.body.append(probe);
      const resolve = (token: string) => {
        probe.style.color = styles.getPropertyValue(token).trim();
        return getComputedStyle(probe).color;
      };
      const result = {
        surfaces: [resolve('--color-bg'), resolve('--rule-soft')],
        colours: ['--color-success', '--color-warning', '--color-danger', '--color-text-muted', '--color-primary']
          .map((token) => [token, resolve(token)] as const),
      };
      probe.remove();
      return result;
    });

    for (const [token, colour] of ratios.colours) {
      for (const surface of ratios.surfaces) {
        const ratio = contrastRatio(parseRgb(colour), parseRgb(surface));
        expect(ratio, `${token} on ${surface} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

test.describe('the reader\'s own text size is respected', () => {
  test('body copy scales with the root font size, like everything around it', async ({ page }) => {
    // Regression: `body { font-size: 15.5px }` froze body copy while rem-based headings kept
    // scaling, taking the heading-to-body ratio from 2:1 to 4:1 at a 32px root. Page zoom
    // still worked, so nothing else noticed.
    await signIn(page);

    const sizes: number[] = [];
    for (const root of [16, 24, 32]) {
      await page.evaluate((px) => { document.documentElement.style.fontSize = `${px}px`; }, root);
      sizes.push(await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize)));
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });

    expect(sizes[1]).toBeGreaterThan(sizes[0] * 1.4);
    expect(sizes[2]).toBeGreaterThan(sizes[1] * 1.2);
  });
});

test.describe('forced colours', () => {
  test('selection survives when backgrounds and shadows are stripped', async ({ page }) => {
    // Regression: selection was carried by a tint plus an inset box-shadow, with a comment
    // claiming that survived forced colours. Forced colours removes box-shadow, so the
    // selected and unselected rows rendered identically.
    await signIn(page);
    await page.getByLabel('Project name').fill('Forced colours subject');
    await page.getByTestId('create-submit').click();
    await expect(page.getByTestId('project-list')).toBeVisible();
    await page.getByTestId('select-project').first().click();

    await page.emulateMedia({ forcedColors: 'active' });

    const distinguishable = await page.evaluate(() => {
      const selected = document.querySelector('[data-testid="project-row"][aria-current]');
      if (selected === null) return { reason: 'no row is marked selected', ok: false };
      const cell = selected.querySelector('th, td') as HTMLElement;
      const border = getComputedStyle(cell).borderBottomWidth;
      return { reason: `border ${border}`, ok: parseFloat(border) > 0 };
    });

    expect(distinguishable.ok, `selection is not conveyed in forced colours: ${distinguishable.reason}`).toBe(true);
    await page.emulateMedia({ forcedColors: null });
  });
});
