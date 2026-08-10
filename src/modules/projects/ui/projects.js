/**
 * Projects — module UI.
 *
 * Responsibility: render the project list and create form, own their UI state, drive the
 * Projects HTTP contract, and publish which project is selected.
 *
 * Place in the system: the Projects module's own UI (Standard 10). The shell provides a
 * slot; everything inside it belongs to this module. Selection is PUBLISHED through
 * `onProjectSelected` rather than reaching into another module — the shell decides what
 * a selection means, so Projects and Releases stay independent.
 *
 * Boundary: presentation and UI state only. Business rules are enforced server-side; this
 * file MUST NOT re-implement them. In particular the project's owning customer is set from
 * the session by the server and is deliberately not a form field.
 */

const API = '/api/projects';

/**
 * UI states for the list region.
 *
 * `partial` remains N/A: one small request, no partial-success mode. `disabled` applies —
 * the create form is disabled when the caller is not authorized to use it.
 */
const ListState = {
  LOADING: 'loading',
  READY: 'ready',
  EMPTY: 'empty',
  ERROR: 'error',
  UNAUTHORIZED: 'unauthorized',
  UNAVAILABLE: 'unavailable',
};

let root = null;
let selectionListener = () => {};
let selectedId = null;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

/** Register the selection callback. The shell uses it to drive other modules. */
export function onProjectSelected(listener) {
  selectionListener = listener;
}

/**
 * Call the Projects API.
 *
 * Distinguishes three failure classes the UI must show differently: the request never
 * reached the service (`unavailable`), the caller is not authenticated (`unauthorized`),
 * and the service refused the request (everything else, carrying its reference id).
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

export function mountProjects(container) {
  root = container;
  selectedId = null;

  root.innerHTML = `
    <form class="stack card projects-form" data-testid="create-project-form" novalidate>
      <h3>Add a project</h3>

      <fieldset class="stack form-fields" data-testid="create-fieldset">
      <legend class="visually-hidden">New project details</legend>

      <div class="field">
        <label for="project-name">Project name</label>
        <input id="project-name" name="name" type="text" autocomplete="off"
               required maxlength="120" aria-describedby="project-name-error" />
        <p class="field__error status-error" id="project-name-error" data-testid="error-name" hidden></p>
      </div>

      <div class="field">
        <label for="project-description">Description <span class="text-muted">(optional)</span></label>
        <textarea id="project-description" name="description" rows="3" maxlength="2000"
                  aria-describedby="project-description-error"></textarea>
        <p class="field__error status-error" id="project-description-error" data-testid="error-description" hidden></p>
      </div>

      <p class="form-summary" data-testid="form-summary" role="alert" hidden></p>

      <div class="cluster">
        <button type="submit" data-testid="create-submit">Create project</button>
      </div>
      </fieldset>

      <p class="status-error form-blocked" data-testid="form-blocked" hidden></p>
    </form>

    <h3>Existing projects</h3>
    <div data-testid="project-list-region" aria-busy="true" data-list-state="loading">
      <p data-testid="list-status" role="status">Loading projects…</p>
      <div data-testid="project-list-content"></div>
    </div>
  `;

  root.querySelector('[data-testid="create-project-form"]').addEventListener('submit', onSubmit);
  void loadProjects();
}

/**
 * DISABLED state.
 *
 * When the caller cannot read projects they cannot create one either, so the form is
 * disabled and says why. Leaving it enabled would offer a capability that always fails.
 */
function setFormAvailability(enabled, reason = '') {
  const fieldset = root.querySelector('[data-testid="create-fieldset"]');
  const blocked = root.querySelector('[data-testid="form-blocked"]');
  if (fieldset === null) return;

  fieldset.disabled = !enabled;
  blocked.hidden = enabled;
  blocked.textContent = enabled ? '' : reason;
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

    // The table scrolls inside its own container at EVERY width; scoping that to small
    // screens let a long project name push the whole document sideways on desktop.
    content.innerHTML = `
      <div class="table-scroll" tabindex="0" role="group" aria-label="Projects table, scrolls horizontally">
      <table class="data-table" data-testid="project-list">
        <caption class="visually-hidden">Projects, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Name</th><th scope="col">Status</th><th scope="col">Created</th>
            <th scope="col">Releases</th><th scope="col">Archive</th>
          </tr>
        </thead>
        <tbody>
          ${projects.map((project) => `
            <tr data-testid="project-row" data-project-id="${escapeHtml(project.id)}"
                ${project.id === selectedId ? 'aria-current="true"' : ''}>
              <th scope="row">${escapeHtml(project.name)}</th>
              <td><span class="badge badge--${escapeHtml(project.status)}">${escapeHtml(project.status)}</span></td>
              <td><time datetime="${escapeHtml(project.createdAt)}">${escapeHtml(project.createdAt.slice(0, 10))}</time></td>
              <td><button type="button" class="control" data-testid="select-project"
                          data-project-id="${escapeHtml(project.id)}">
                    View releases<span class="visually-hidden"> for ${escapeHtml(project.name)}</span>
                  </button></td>
              <td>${project.status === 'archived'
                ? '<span class="text-muted" data-testid="archive-unavailable">archived</span>'
                : `<button type="button" class="control control--danger" data-testid="archive-project"
                            data-project-id="${escapeHtml(project.id)}" data-project-name="${escapeHtml(project.name)}">
                      Archive<span class="visually-hidden"> ${escapeHtml(project.name)}</span>
                    </button>`}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      </div>`;

    for (const button of content.querySelectorAll('[data-testid="archive-project"]')) {
      button.addEventListener('click', () => void confirmArchive(button));
    }

    for (const button of content.querySelectorAll('[data-testid="select-project"]')) {
      button.addEventListener('click', () => {
        selectedId = button.dataset.projectId;
        const project = projects.find((candidate) => candidate.id === selectedId);
        for (const row of content.querySelectorAll('[data-testid="project-row"]')) {
          row.toggleAttribute('aria-current', row.dataset.projectId === selectedId);
        }
        selectionListener(project ?? null);
      });
    }
    return;
  }

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
 * Ask before archiving.
 *
 * Risk determines friction (Standard 10). Creating a project is reversible and needs none;
 * archiving cannot be undone, so it gets an explicit confirmation naming the project. The
 * prompt states the consequence — no longer editable, cannot be restored — rather than
 * asking a bare "are you sure", which trains people to click through.
 */
async function confirmArchive(button) {
  const name = button.dataset.projectName;
  const confirmed = window.confirm(
    `Archive "${name}"?\n\n`
    + 'An archived project can no longer be edited, and archiving cannot be undone.',
  );
  if (!confirmed) return;

  const summary = root.querySelector('[data-testid="form-summary"]');
  summary.hidden = true;

  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'Archiving…';

  try {
    await callApi(`${API}/${encodeURIComponent(button.dataset.projectId)}/archive`, { method: 'POST', body: '{}' });
    await loadProjects();

    summary.hidden = false;
    summary.className = 'form-summary status-success';
    summary.textContent = `Archived "${name}".`;
  } catch (error) {
    summary.hidden = false;
    summary.className = 'form-summary status-error';
    summary.textContent = error.reference ? `${error.message} Reference: ${error.reference}` : error.message;

    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = 'Archive';
  }
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

    const firstInvalid = form.querySelector('[aria-invalid="true"]');
    if (firstInvalid) firstInvalid.focus();
  } finally {
    submit.disabled = false;
    submit.removeAttribute('aria-busy');
    submit.textContent = 'Create project';
  }
}
