/**
 * Incidents and AI triage — browser proof.
 *
 * What this defends: the Standard 10 rules for AI interfaces, which are the ones most easily
 * satisfied in prose and violated in pixels —
 *   - AI interpretation is visually and semantically distinct from recorded facts;
 *   - a suggested severity never masquerades as the incident's severity;
 *   - a rejected assessment shows NOTHING, not a fragment;
 *   - in-flight work is never presented as complete, and progress is honest;
 *   - ambiguity changes what the interface says.
 *
 * The triage responses are intercepted, so this spends no subscription capacity. Model
 * quality is the eval suite's job; this file is about what a person sees.
 */

import { test, expect, type Page } from '@playwright/test';
import { ACME } from './fixture.ts';

const ASSESSMENT = {
  status: 'assessed',
  assessment: {
    severity: 'SEV-1',
    affectedCapability: 'projects',
    summary: 'Project creation has failed for all customers since 09:00.',
    hypotheses: ['A bad release broke the create path', 'The projects table is rejecting writes'],
    recommendedNextInvestigation: 'Compare the current release revision against the last known good one.',
    evidenceRefs: ['e1'],
    confidence: 'high',
  },
  meta: { provider: 'claude-cli', model: 'claude-haiku-4-5-20251001', promptVersion: 'triage-prompt-v2', latencyMs: 1200, attempts: 1 },
};

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(ACME.email);
  await page.getByLabel('Password').fill(ACME.password);
  await page.getByTestId('signin-submit').click();
  await expect(page.getByTestId('signed-in-view')).toBeVisible();
}

/** Report an incident through the real form and select it for analysis. */
async function reportAndSelect(page: Page, title: string) {
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('What is happening').fill('Every create returns 500.\n\nReads still work.');
  await page.getByTestId('incident-submit').click();
  await expect(page.getByTestId('incident-summary')).toHaveText(new RegExp(`Reported "${title}"`));
  await page.getByTestId('select-incident').first().click();
}

test.describe('incidents', () => {
  test('an incident can be reported and appears with its recorded severity', async ({ page }) => {
    await signIn(page);
    await expect(page.locator('[data-incident-state]')).toHaveAttribute('data-incident-state', 'empty');

    await reportAndSelect(page, 'Project creation failing');

    const row = page.getByTestId('incident-row').first();
    await expect(row).toContainText('Project creation failing');
    await expect(row.getByTestId('recorded-severity')).toHaveText('SEV-2');
    // "No Case yet" is stated rather than left blank, so absence is distinguishable from
    // an unrendered value.
    await expect(row).toContainText('no Case yet');

    await page.screenshot({ path: 'test-results/proof-s3-01-incidents.png', fullPage: true });
  });
});

test.describe('AI analysis view', () => {
  test('the idle state invites selection rather than showing an empty panel', async ({ page }) => {
    await signIn(page);
    await expect(page.locator('[data-triage-state]')).toHaveAttribute('data-triage-state', 'idle');
    await expect(page.getByTestId('triage-status')).toHaveText(/Select an incident/);
  });

  test('an assessment is labelled as interpretation and never as a finding', async ({ page }) => {
    await signIn(page);
    await page.route('**/triage', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ data: ASSESSMENT }),
    }));

    await reportAndSelect(page, 'Project creation failing');
    await page.getByTestId('run-triage').click();

    const panel = page.getByTestId('triage-assessment');
    await expect(panel).toBeVisible();

    // Provenance is explicit: whose words these are, and that nothing changed.
    await expect(page.getByTestId('triage-provenance')).toContainText('interpretation, not a finding');
    await expect(page.getByTestId('triage-provenance')).toContainText('has not changed the incident');
    await expect(panel.locator('.ai-panel__label')).toContainText('AI interpretation');

    await expect(page.getByTestId('triage-summary')).toContainText('Project creation has failed');
    await expect(page.getByTestId('triage-hypotheses').locator('li')).toHaveCount(2);
    await expect(page.getByTestId('triage-recommendation')).toContainText('release revision');

    // Consequential conclusions expose their evidence.
    await expect(page.getByTestId('triage-evidence')).toContainText('e1');

    await page.screenshot({ path: 'test-results/proof-s3-02-assessment.png', fullPage: true });
  });

  test('the suggested severity is marked as a suggestion and does not change the record', async ({ page }) => {
    await signIn(page);
    await page.route('**/triage', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ data: ASSESSMENT }),
    }));

    await reportAndSelect(page, 'Project creation failing');
    await page.getByTestId('run-triage').click();

    // The model said SEV-1; the incident was reported SEV-2. Both must be visible, and the
    // suggestion must be labelled — otherwise a reader would take it as the new severity.
    await expect(page.getByTestId('suggested-severity')).toHaveText('SEV-1');
    await expect(page.getByTestId('triage-assessment')).toContainText('recorded severity is unchanged');
    await expect(page.getByTestId('incident-row').first().getByTestId('recorded-severity')).toHaveText('SEV-2');

    // Marked provisional by more than colour: the border style differs from a recorded badge.
    const suggestedStyle = await page.getByTestId('suggested-severity').evaluate((el) => getComputedStyle(el).borderStyle);
    const recordedStyle = await page.getByTestId('recorded-severity').first().evaluate((el) => getComputedStyle(el).borderStyle);
    expect(suggestedStyle).not.toBe(recordedStyle);
  });

  test('low confidence and an unknown capability change what the interface says', async ({ page }) => {
    await signIn(page);
    await page.route('**/triage', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          ...ASSESSMENT,
          assessment: { ...ASSESSMENT.assessment, confidence: 'low', affectedCapability: 'unknown', evidenceRefs: [] },
        },
      }),
    }));

    await reportAndSelect(page, 'Something is slow');
    await page.getByTestId('run-triage').click();

    // Ambiguity is surfaced rather than smoothed over.
    await expect(page.getByTestId('triage-uncertainty')).toBeVisible();
    await expect(page.getByTestId('triage-uncertainty')).toContainText(/caution/i);
    await expect(page.getByTestId('affected-capability')).toHaveText('unknown');
    // An empty citation list is stated, not hidden.
    await expect(page.getByTestId('triage-evidence')).toContainText('No specific part');

    await page.screenshot({ path: 'test-results/proof-s3-03-low-confidence.png', fullPage: true });
  });

  test('a rejected assessment shows an explanation and NO fragment of the answer', async ({ page }) => {
    await signIn(page);
    await page.route('**/triage', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          status: 'unavailable',
          reason: 'ungrounded_evidence',
          detail: 'cited an evidence id that was not supplied',
          meta: ASSESSMENT.meta,
        },
      }),
    }));

    await reportAndSelect(page, 'Releases failing');
    await page.getByTestId('run-triage').click();

    await expect(page.locator('[data-triage-state]')).toHaveAttribute('data-triage-state', 'unavailable');
    await expect(page.getByTestId('triage-status')).toContainText('cited evidence that was not part of this incident');
    await expect(page.getByTestId('triage-status')).toContainText('incident is unchanged');

    // Nothing partial is rendered: showing a fragment would invite acting on an answer the
    // system rejected.
    await expect(page.getByTestId('triage-assessment')).toHaveCount(0);
    // The internal diagnostic names a schema field and must not reach a responder.
    await expect(page.getByTestId('triage-status')).not.toContainText('evidence id that was not supplied');

    await page.screenshot({ path: 'test-results/proof-s3-04-unavailable.png', fullPage: true });
  });

  test('every failure reason has a plain-language explanation', async ({ page }) => {
    await signIn(page);
    await reportAndSelect(page, 'Reason coverage');

    for (const reason of ['provider_unavailable', 'provider_timeout', 'unparseable_output', 'schema_invalid', 'unknown_capability']) {
      await page.route('**/triage', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { status: 'unavailable', reason, meta: ASSESSMENT.meta } }),
      }));

      await page.getByTestId('run-triage').click();
      const status = page.getByTestId('triage-status');
      await expect(status).toContainText('incident is unchanged');
      // No raw reason code leaks into the interface.
      await expect(status).not.toContainText(reason);
    }
  });

  test('in-flight analysis is never presented as complete, with honest progress', async ({ page }) => {
    await signIn(page);

    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/triage', async (route) => {
      await held;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: ASSESSMENT }) });
    });

    await reportAndSelect(page, 'Slow analysis');
    const button = page.getByTestId('run-triage');
    await button.click();

    await expect(page.locator('[data-triage-state]')).toHaveAttribute('data-triage-state', 'running');
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('aria-busy', 'true');
    // Honest progress: a duration hint, not an invented percentage.
    await expect(page.getByTestId('triage-status')).toContainText(/usually takes/);
    await expect(page.getByTestId('triage-assessment')).toHaveCount(0);

    await page.screenshot({ path: 'test-results/proof-s3-05-running.png', fullPage: true });

    release();
    await expect(page.getByTestId('triage-assessment')).toBeVisible();
    await expect(button).toBeEnabled();
  });
});
