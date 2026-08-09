/**
 * Projects — module UI.
 *
 * Responsibility: render the project list and the create form, own their UI state, and
 * drive the Projects HTTP contract.
 *
 * Place in the system: the Projects module's own UI (Standard 10). The shell provides the
 * `[data-projects-root]` slot; everything inside it belongs to this module. No other
 * module's UI reads or writes this state.
 *
 * Boundary: presentation and UI state only. Business rules are enforced server-side by the
 * module's domain layer — this file MUST NOT re-implement them, or the two would drift.
 * Client-side `required` attributes are an affordance, not the validation of record.
 */

const API = '/api/projects';

/**
 * UI states for the list region, per the capability checklist.
 *
 * `partial` and `disabled` are deliberately absent: the list is a single small request with
 * no partial-success mode, and there is no permission tier in slice 1 that renders the form
 * disabled rather than absent.
 */
const ListState = {
  LOADING: 'loading',
  READY: 'ready',
  EMPTY: 'empty',
  ERROR: 'error',
  UNAUTHORIZED: 'unauthorized',
  UNAVAILABLE: 'unavailable',
};

const root = document.querySelector('[data-projects-root]');

/** Escape text before interpolation. The list renders server-stored names. */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

/**
 * Call the Projects API.
 *
 * Distinguishes three failure classes the UI must show differently: the request never
 * reached the service (`unavailable`), the caller is not identified (`unauthorized`), and
 * the service refused the request (everything else, carrying its reference id).
 */
async function callApi(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    });
  } catch {
    throw { kind: 'unavailable', message: 'Foundation Lab is unreachable. Check your connection and try again.', reference: '' };
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw payload.error ?? { kind: 'internal', message: 'Something went wrong.', reference: '' };
  }
  return payload.data;
}

function render() {
  root.innerHTML = `
    <form class="stack projects-form" data-testid="create-project-form" novalidate>
      <h3>Add a project</h3>

      <!-- One fieldset around every control, so the DISABLED state is a single honest
           switch rather than per-input bookkeeping that can drift out of step. -->
      <fieldset class="stack form-fields" data-testid="create-fieldset">
      <legend class="visually-hidden">New project details</legend>

      <div class="field">
        <label for="project-name">Project name</label>
        <input id="project-name" name="name" type="text" autocomplete="off"
               required maxlength="120" aria-describedby="project-name-error" />
        <p class="field__error status-error" id="project-name-error" data-testid="error-name" hidden></p>
      </div>

      <div class="field">
        <label for="project-customer">Customer id</label>
        <input id="project-customer" name="customerId" type="text" autocomplete="off"
               required aria-describedby="project-customer-hint project-customer-error" />
        <p class="text-muted field__hint" id="project-customer-hint">
          The customer that owns this project.
        </p>
        <p class="field__error status-error" id="project-customer-error" data-testid="error-customerId" hidden></p>
      </div>

      <div class="field">
        <label for="project-description">Description <span class="text-muted">(optional)</span></label>
        <textarea id="project-description" name="description" rows="3" maxlength="2000"
                  aria-describedby="project-description-error"></textarea>
        <p class="field__error status-error" id="project-description-error" data-testid="error-description" hidden></p>
      </div>

      <!-- The summary sits above the button, next to the fields it refers to. Below the
           button it appeared underneath the very fields its text says to correct. -->
      <p class="form-summary" data-testid="form-summary" role="alert" hidden></p>

      <div class="cluster">
        <button type="submit" data-testid="create-submit">Create project</button>
      </div>
      </fieldset>

      <p class="status-error form-blocked" data-testid="form-blocked" hidden></p>
    </form>

    <h3>Existing projects</h3>
    <!-- The live region is the status line ONLY. It used to wrap the table too, so every
         create re-announced every row and cell on top of the success message. -->
    <div data-testid="project-list-region" aria-busy="true" data-list-state="loading">
      <p data-testid="list-status" role="status">Loading projects…</p>
      <div data-testid="project-list-content"></div>
    </div>
  `;

  root.querySelector('[data-testid="create-project-form"]').addEventListener('submit', onSubmit);
  void loadProjects();
}

/**
 * Render the list region for one state.
 *
 * Status text and table content are written separately: only the status paragraph is a live
 * region, so a reload announces "3 projects" rather than reading out every row.
 */
function renderList(state, projects = [], error = null) {
  const region = root.querySelector('[data-testid="project-list-region"]');
  const status = root.querySelector('[data-testid="list-status"]');
  const content = root.querySelector('[data-testid="project-list-content"]');

  region.setAttribute('aria-busy', String(state === ListState.LOADING));
  // Always-present state marker. The region's inner elements differ per state, so without
  // this there is no single stable signal for "which state am I in" — needed by anything
  // observing the region, including browser proof.
  region.dataset.listState = state;
  status.className = '';
  content.innerHTML = '';

  if (state === ListState.LOADING) {
    status.textContent = 'Loading projects…';
    return;
  }

  if (state === ListState.EMPTY) {
    status.className = 'text-muted';
    status.textContent = 'No projects yet. Add the first one using the form above.';
    return;
  }

  if (state === ListState.READY) {
    status.className = 'visually-hidden';
    status.textContent = `${projects.length} ${projects.length === 1 ? 'project' : 'projects'}.`;
    // The table lives in its own scroll container at EVERY width. Scoping the container to
    // small screens let a long project name push the whole document sideways on desktop.
    content.innerHTML = `
      <div class="projects-table-scroll" tabindex="0" role="group" aria-label="Projects table, scrolls horizontally">
      <table class="projects-table" data-testid="project-list">
        <caption class="visually-hidden">Projects, newest first</caption>
        <thead>
          <tr><th scope="col">Name</th><th scope="col">Customer</th><th scope="col">Status</th><th scope="col">Created</th></tr>
        </thead>
        <tbody>
          ${projects.map((project) => `
            <tr data-testid="project-row" data-project-id="${escapeHtml(project.id)}">
              <th scope="row">${escapeHtml(project.name)}</th>
              <td>${escapeHtml(project.customerId)}</td>
              <td><span class="badge badge--${escapeHtml(project.status)}">${escapeHtml(project.status)}</span></td>
              <td><time datetime="${escapeHtml(project.createdAt)}">${escapeHtml(project.createdAt.slice(0, 10))}</time></td>
            </tr>`).join('')}
        </tbody>
      </table>
      </div>`;
    return;
  }

  // Failure states explain impact and recovery, and keep the reference id for support.
  const messages = {
    [ListState.UNAUTHORIZED]: 'You are not signed in, so projects cannot be shown. Sign in and reload.',
    [ListState.UNAVAILABLE]: 'Foundation Lab is unreachable, so projects cannot be shown right now. Try again shortly.',
    [ListState.ERROR]: 'Projects could not be loaded.',
  };

  status.className = 'status-error';
  status.textContent = error?.reference
    ? `${messages[state]} Reference: ${error.reference}`
    : messages[state];
}

/**
 * DISABLED state.
 *
 * When the caller is not authorized to read projects they cannot create one either, so the
 * form is disabled and says why. Leaving it enabled offered a capability that always failed
 * on submit — an invitation the application could not honour.
 */
function setFormAvailability(enabled, reason = '') {
  const fieldset = root.querySelector('[data-testid="create-fieldset"]');
  const blocked = root.querySelector('[data-testid="form-blocked"]');
  if (fieldset === null) return;

  fieldset.disabled = !enabled;
  blocked.hidden = enabled;
  blocked.textContent = enabled ? '' : reason;
}

async function loadProjects() {
  renderList(ListState.LOADING);
  try {
    const projects = await callApi(API);
    setFormAvailability(true);
    renderList(projects.length === 0 ? ListState.EMPTY : ListState.READY, projects);
  } catch (error) {
    const state = error.kind === 'unauthorized' ? ListState.UNAUTHORIZED
      : error.kind === 'unavailable' || error.kind === 'dependency' ? ListState.UNAVAILABLE
      : ListState.ERROR;

    if (state === ListState.UNAUTHORIZED) {
      setFormAvailability(false, 'You are not signed in, so you cannot create a project. Sign in and reload.');
    }
    renderList(state, [], error);
  }
}

/** Clear previous field errors so a retry never shows stale messages. */
function clearFieldErrors(form) {
  for (const element of form.querySelectorAll('.field__error')) {
    element.hidden = true;
    element.textContent = '';
  }
  for (const control of form.querySelectorAll('[aria-invalid]')) {
    control.removeAttribute('aria-invalid');
  }
  const summary = form.querySelector('[data-testid="form-summary"]');
  summary.hidden = true;
  summary.textContent = '';
  summary.className = 'form-summary';
}

/**
 * Handle a create submission.
 *
 * Server-reported field errors are attached to their own control via `aria-invalid` and the
 * already-associated `aria-describedby` target, so a screen reader hears which field failed
 * and why — not just that something went wrong.
 */
async function onSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[data-testid="create-submit"]');
  const summary = form.querySelector('[data-testid="form-summary"]');

  clearFieldErrors(form);

  // Submitting state: the control is disabled and busy, so a double submit cannot happen.
  submit.disabled = true;
  submit.setAttribute('aria-busy', 'true');
  submit.textContent = 'Creating…';

  const data = Object.fromEntries(new FormData(form).entries());

  try {
    const project = await callApi(API, { method: 'POST', body: JSON.stringify(data) });

    form.reset();
    summary.hidden = false;
    summary.className = 'form-summary status-success';
    summary.textContent = `Created "${project.name}".`;

    await loadProjects();
    form.querySelector('#project-name').focus();
  } catch (error) {
    for (const [field, message] of Object.entries(error.details ?? {})) {
      const control = form.querySelector(`[name="${field}"]`);
      const target = form.querySelector(`[data-testid="error-${field}"]`);
      if (control) control.setAttribute('aria-invalid', 'true');
      if (target) {
        target.hidden = false;
        target.textContent = message;
      }
    }

    summary.hidden = false;
    summary.className = 'form-summary status-error';
    summary.textContent = error.reference
      ? `${error.message} Reference: ${error.reference}`
      : error.message;

    // Send focus to the first field that failed so keyboard users are not stranded.
    const firstInvalid = form.querySelector('[aria-invalid="true"]');
    if (firstInvalid) firstInvalid.focus();
  } finally {
    submit.disabled = false;
    submit.removeAttribute('aria-busy');
    submit.textContent = 'Create project';
  }
}

render();
