/**
 * Incidents — module UI.
 *
 * Responsibility: list incidents, create one, and publish which is selected.
 *
 * Place in the system: the Incidents module's own UI. Selection is PUBLISHED, and the shell
 * decides what it means — so Incidents and Triage stay independent of each other.
 */

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const API = '/api/incidents';
let root = null;
let selectionListener = () => {};
let selectedId = null;

export function onIncidentSelected(listener) {
  selectionListener = listener;
}

export function mountIncidents(container) {
  root = container;
  selectedId = null;

  root.innerHTML = `
    <form class="stack incidents-form" data-testid="create-incident-form" novalidate>
      <h3>Report an incident</h3>
      <fieldset class="stack form-fields" data-testid="incident-fieldset">
        <legend class="visually-hidden">New incident details</legend>

        <div class="field">
          <label for="incident-title">Title</label>
          <input id="incident-title" name="title" type="text" maxlength="200"
                 autocomplete="off" required aria-describedby="incident-title-error" />
          <p class="field__error status-error" id="incident-title-error" data-testid="error-title" hidden></p>
        </div>

        <div class="field">
          <label for="incident-report">What is happening</label>
          <textarea id="incident-report" name="report" rows="4" maxlength="8000"
                    required aria-describedby="incident-report-error"></textarea>
          <p class="field__error status-error" id="incident-report-error" data-testid="error-report" hidden></p>
        </div>

        <div class="field">
          <label for="incident-severity">Severity</label>
          <select id="incident-severity" name="severity" aria-describedby="incident-severity-error">
            <option value="SEV-3">SEV-3 — minor</option>
            <option value="SEV-2" selected>SEV-2 — limited impact</option>
            <option value="SEV-1">SEV-1 — major degradation</option>
            <option value="SEV-0">SEV-0 — outage or compromise</option>
          </select>
          <p class="field__error status-error" id="incident-severity-error" data-testid="error-severity" hidden></p>
        </div>

        <p class="form-summary" data-testid="incident-summary" role="alert" hidden></p>
        <div class="cluster"><button type="submit" data-testid="incident-submit">Report incident</button></div>
      </fieldset>
    </form>

    <h3>Open incidents</h3>
    <div data-testid="incident-list-region" aria-busy="true" data-incident-state="loading">
      <p data-testid="incident-status" role="status">Loading incidents…</p>
      <div data-testid="incident-list-content"></div>
    </div>`;

  root.querySelector('[data-testid="create-incident-form"]').addEventListener('submit', onSubmit);
  void loadIncidents();
}

async function callApi(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } });
  } catch {
    throw { kind: 'unavailable', message: 'Foundation Lab is unreachable.', reference: '' };
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw payload.error ?? { kind: 'internal', message: 'Something went wrong.', reference: '' };
  return payload.data;
}

function render(state, incidents = [], error = null) {
  const region = root.querySelector('[data-testid="incident-list-region"]');
  const status = root.querySelector('[data-testid="incident-status"]');
  const content = root.querySelector('[data-testid="incident-list-content"]');

  region.setAttribute('aria-busy', String(state === 'loading'));
  region.dataset.incidentState = state;
  status.className = '';
  content.innerHTML = '';

  if (state === 'loading') { status.textContent = 'Loading incidents…'; return; }
  if (state === 'empty') {
    status.className = 'text-muted';
    status.textContent = 'No incidents reported. That is the good outcome.';
    return;
  }
  if (state !== 'ready') {
    status.className = 'status-error';
    status.textContent = error?.kind === 'unauthorized'
      ? 'You are not signed in, so incidents cannot be shown.'
      : 'Incidents could not be loaded.';
    return;
  }

  status.className = 'visually-hidden';
  status.textContent = `${incidents.length} ${incidents.length === 1 ? 'incident' : 'incidents'}.`;

  content.innerHTML = `
    <div class="table-scroll" tabindex="0" role="group" aria-label="Incidents table, scrolls horizontally">
    <table class="data-table" data-testid="incident-list">
      <caption class="visually-hidden">Incidents, newest first</caption>
      <thead><tr>
        <th scope="col">Title</th><th scope="col">Severity</th><th scope="col">Status</th>
        <th scope="col">Case</th><th scope="col">Analysis</th>
      </tr></thead>
      <tbody>
        ${incidents.map((incident) => `
          <tr data-testid="incident-row" data-incident-id="${escapeHtml(incident.id)}"
              ${incident.id === selectedId ? 'aria-current="true"' : ''}>
            <th scope="row">${escapeHtml(incident.title)}</th>
            <td><span class="badge badge--recorded" data-testid="recorded-severity">${escapeHtml(incident.severity)}</span></td>
            <td>${escapeHtml(incident.status)}</td>
            <td>${incident.caseRef === null
              ? '<span class="text-muted">no Case yet</span>'
              : `<code>${escapeHtml(incident.caseRef)}</code>`}</td>
            <td><button type="button" class="control" data-testid="select-incident"
                        data-incident-id="${escapeHtml(incident.id)}">
                  Select<span class="visually-hidden"> ${escapeHtml(incident.title)} for analysis</span>
                </button></td>
          </tr>`).join('')}
      </tbody>
    </table>
    </div>`;

  for (const button of content.querySelectorAll('[data-testid="select-incident"]')) {
    button.addEventListener('click', () => {
      selectedId = button.dataset.incidentId;
      for (const row of content.querySelectorAll('[data-testid="incident-row"]')) {
        row.toggleAttribute('aria-current', row.dataset.incidentId === selectedId);
      }
      selectionListener(incidents.find((candidate) => candidate.id === selectedId) ?? null);
    });
  }
}

async function loadIncidents() {
  render('loading');
  try {
    const incidents = await callApi(API);
    render(incidents.length === 0 ? 'empty' : 'ready', incidents);
  } catch (error) {
    render(error.kind === 'unauthorized' ? 'unauthorized' : 'error', [], error);
  }
}

async function onSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[data-testid="incident-submit"]');
  const summary = form.querySelector('[data-testid="incident-summary"]');

  for (const element of form.querySelectorAll('.field__error')) { element.hidden = true; element.textContent = ''; }
  for (const control of form.querySelectorAll('[aria-invalid]')) control.removeAttribute('aria-invalid');
  summary.hidden = true;
  summary.className = 'form-summary';

  submit.disabled = true;
  submit.setAttribute('aria-busy', 'true');
  submit.textContent = 'Reporting…';

  try {
    const incident = await callApi(API, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
    form.reset();
    summary.hidden = false;
    summary.className = 'form-summary status-success';
    summary.textContent = `Reported "${incident.title}".`;
    await loadIncidents();
    form.querySelector('#incident-title').focus();
  } catch (error) {
    for (const [field, message] of Object.entries(error.details ?? {})) {
      const control = form.querySelector(`[name="${field}"]`);
      const target = form.querySelector(`[data-testid="error-${field}"]`);
      if (control) control.setAttribute('aria-invalid', 'true');
      if (target) { target.hidden = false; target.textContent = message; }
    }
    summary.hidden = false;
    summary.className = 'form-summary status-error';
    summary.textContent = error.reference ? `${error.message} Reference: ${error.reference}` : error.message;
    const firstInvalid = form.querySelector('[aria-invalid="true"]');
    if (firstInvalid) firstInvalid.focus();
  } finally {
    submit.disabled = false;
    submit.removeAttribute('aria-busy');
    submit.textContent = 'Report incident';
  }
}
