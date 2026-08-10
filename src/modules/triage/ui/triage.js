/**
 * Incident Triage — module UI.
 *
 * Responsibility: let a person request an assessment for an incident, and show the result
 * honestly.
 *
 * Place in the system: the Triage module's own UI. It renders into a slot the shell
 * provides.
 *
 * AI INTERFACE RULES (Standard 10) — the whole point of this file:
 * - **User data, grounded evidence, and AI interpretation are visually distinct.** The
 *   incident report is the user's words; the cited evidence is what the assessment claims to
 *   have relied on; the severity, hypotheses and summary are the model's interpretation and
 *   are labelled as such. A reader must never have to guess which is which.
 * - **The suggested severity is never presented as the incident's severity.** It sits beside
 *   the recorded one, marked as a suggestion, and changing the record stays a separate,
 *   deliberate act.
 * - **Ambiguity changes the interface.** Low confidence and an `unknown` capability are
 *   shown prominently rather than smoothed over.
 * - **Queued work is never shown as complete.** While a request is in flight the UI says so,
 *   with honest indeterminate progress and no invented percentage.
 * - **Unavailable is a real state with a real explanation**, not an empty panel.
 */

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

/**
 * Plain-language explanations of every failure reason.
 *
 * Each says what happened and what to do. The internal `detail` is deliberately NOT shown:
 * it names a schema field and would mean nothing to a responder.
 */
const FAILURE_MESSAGES = {
  provider_unavailable: 'The analysis service could not be reached, so no assessment was produced. The incident is unchanged. Try again shortly.',
  provider_timeout: 'The analysis took too long and was stopped, so no assessment was produced. The incident is unchanged. Try again shortly.',
  unparseable_output: 'The analysis came back in a form this application could not read, so it was discarded rather than guessed at. The incident is unchanged.',
  schema_invalid: 'The analysis did not meet the required structure, so it was rejected rather than shown partially. The incident is unchanged.',
  ungrounded_evidence: 'The analysis cited evidence that was not part of this incident, so it was rejected as unreliable. The incident is unchanged.',
  unknown_capability: 'The analysis named a capability that does not exist in this system, so it was rejected as unreliable. The incident is unchanged.',
};

let root = null;
let currentIncident = null;

export function mountTriage(container) {
  root = container;
  renderIdle();
}

/** Show which incident is selected, and offer analysis. Called by the shell. */
export function showTriageFor(incident) {
  currentIncident = incident;
  if (root === null) return;
  if (incident === null) return renderIdle();

  root.innerHTML = `
    <div data-testid="triage-region" data-triage-state="ready">
      <p data-testid="triage-status" role="status" class="text-muted">
        No analysis has been run for “${escapeHtml(incident.title)}”.
      </p>
      <div class="cluster">
        <button type="button" data-testid="run-triage">Analyse this incident</button>
      </div>
      <div data-testid="triage-content"></div>
    </div>`;

  root.querySelector('[data-testid="run-triage"]').addEventListener('click', () => void runTriage());
}

function renderIdle() {
  root.innerHTML = `
    <div data-testid="triage-region" data-triage-state="idle">
      <p data-testid="triage-status" role="status" class="text-muted">
        Select an incident to analyse it.
      </p>
      <div data-testid="triage-content"></div>
    </div>`;
}

async function runTriage() {
  const region = root.querySelector('[data-testid="triage-region"]');
  const status = root.querySelector('[data-testid="triage-status"]');
  const content = root.querySelector('[data-testid="triage-content"]');
  const button = root.querySelector('[data-testid="run-triage"]');

  // Honest progress: the work takes an unpredictable time and the interface says so rather
  // than animating a percentage nobody measured.
  region.dataset.triageState = 'running';
  status.className = 'text-muted';
  status.textContent = 'Analysing. This usually takes up to half a minute.';
  content.innerHTML = '';
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'Analysing…';

  try {
    const response = await fetch(`/api/incidents/${encodeURIComponent(currentIncident.id)}/triage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      region.dataset.triageState = 'error';
      status.className = 'status-error';
      status.textContent = payload.error?.message ?? 'The analysis could not be started.';
      return;
    }

    const outcome = payload.data;
    if (outcome.status === 'unavailable') return renderUnavailable(outcome);
    renderAssessment(outcome);
  } catch {
    region.dataset.triageState = 'unavailable';
    status.className = 'status-error';
    status.textContent = 'Foundation Lab is unreachable, so no analysis could be run.';
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = 'Analyse this incident';
  }
}

function renderUnavailable(outcome) {
  const region = root.querySelector('[data-testid="triage-region"]');
  const status = root.querySelector('[data-testid="triage-status"]');
  const content = root.querySelector('[data-testid="triage-content"]');

  region.dataset.triageState = 'unavailable';
  status.className = 'status-error';
  status.textContent = FAILURE_MESSAGES[outcome.reason] ?? 'No assessment was produced. The incident is unchanged.';
  // No partial assessment is rendered. There is nothing to show, and showing a fragment
  // would invite someone to act on an answer the system rejected.
  content.innerHTML = '';
}

function renderAssessment(outcome) {
  const region = root.querySelector('[data-testid="triage-region"]');
  const status = root.querySelector('[data-testid="triage-status"]');
  const content = root.querySelector('[data-testid="triage-content"]');
  const { assessment, meta } = outcome;

  region.dataset.triageState = 'assessed';
  status.className = 'visually-hidden';
  status.textContent = 'Analysis complete.';

  const lowConfidence = assessment.confidence === 'low' || assessment.affectedCapability === 'unknown';

  content.innerHTML = `
    <section class="ai-panel" data-testid="triage-assessment" aria-labelledby="triage-heading">
      <h4 id="triage-heading" class="ai-panel__label">
        <span aria-hidden="true">✦</span> AI interpretation
      </h4>

      <!-- Says plainly whose words these are. A reader should never have to infer it. -->
      <p class="ai-panel__provenance text-muted" data-testid="triage-provenance">
        Generated by ${escapeHtml(meta.model)}. This is an interpretation, not a finding, and
        it has not changed the incident.
      </p>

      ${lowConfidence ? `
        <p class="status-warning" data-testid="triage-uncertainty">
          Treat this with caution: ${assessment.affectedCapability === 'unknown'
            ? 'the report did not identify a capability'
            : `stated confidence is ${escapeHtml(assessment.confidence)}`}.
        </p>` : ''}

      <dl class="ai-panel__facts">
        <dt>Suggested severity</dt>
        <dd>
          <span class="badge badge--suggested" data-testid="suggested-severity">${escapeHtml(assessment.severity)}</span>
          <span class="text-muted">suggested — the recorded severity is unchanged</span>
        </dd>

        <dt>Affected capability</dt>
        <dd data-testid="affected-capability">${escapeHtml(assessment.affectedCapability)}</dd>

        <dt>Confidence</dt>
        <dd data-testid="triage-confidence">${escapeHtml(assessment.confidence)}</dd>
      </dl>

      <h5>Summary</h5>
      <p data-testid="triage-summary">${escapeHtml(assessment.summary)}</p>

      <h5>Possible causes</h5>
      <ul data-testid="triage-hypotheses">
        ${assessment.hypotheses.map((entry) => `<li>${escapeHtml(entry)}</li>`).join('')}
      </ul>

      <h5>Recommended next step</h5>
      <p data-testid="triage-recommendation">${escapeHtml(assessment.recommendedNextInvestigation)}</p>

      <!-- Citations: what the interpretation claims to rest on. A consequential conclusion
           must expose its evidence, and an empty list is stated rather than hidden. -->
      <h5>Evidence used</h5>
      ${assessment.evidenceRefs.length === 0
        ? '<p class="text-muted" data-testid="triage-evidence">No specific part of the report was cited.</p>'
        : `<ul data-testid="triage-evidence">
            ${assessment.evidenceRefs.map((ref) => `<li><code>${escapeHtml(ref)}</code></li>`).join('')}
          </ul>`}
    </section>`;
}
