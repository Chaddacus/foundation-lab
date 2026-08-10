/**
 * Releases — module UI.
 *
 * Responsibility: show the releases of a selected project and allow a status advance.
 *
 * Place in the system: the Releases module's own UI. It renders into a slot the shell
 * provides and owns everything inside it.
 *
 * Boundary: presentation and UI state only. Which transitions are legal is decided by the
 * server; this file asks and reflects the answer rather than re-implementing the state
 * machine, which would drift.
 */

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const STATUS_LABELS = {
  pending: 'pending',
  deployed: 'deployed',
  verified: 'verified',
  rolled_back: 'rolled back',
};

let root = null;

export function mountReleases(container) {
  root = container;
  root.innerHTML = `
    <div data-testid="releases-region" data-releases-state="idle">
      <p data-testid="releases-status" role="status" class="text-muted">
        Select a project to see its releases.
      </p>
      <div data-testid="releases-content"></div>
    </div>
  `;
}

/**
 * Show the releases of one project.
 *
 * A null project id returns the region to its idle state rather than showing an empty
 * table, because "no project selected" and "this project has no releases" are different
 * facts and must not look identical.
 */
export async function showReleasesFor(projectId, projectName) {
  if (root === null) return;

  const region = root.querySelector('[data-testid="releases-region"]');
  const status = root.querySelector('[data-testid="releases-status"]');
  const content = root.querySelector('[data-testid="releases-content"]');

  if (projectId === null) {
    region.dataset.releasesState = 'idle';
    status.className = 'text-muted';
    status.textContent = 'Select a project to see its releases.';
    content.innerHTML = '';
    return;
  }

  region.dataset.releasesState = 'loading';
  status.className = 'text-muted';
  status.textContent = `Loading releases for ${projectName}…`;
  content.innerHTML = '';

  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/releases`, {
      headers: { 'content-type': 'application/json' },
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      region.dataset.releasesState = response.status === 401 ? 'unauthorized' : 'error';
      status.className = 'status-error';
      status.textContent = payload.error?.message ?? 'Releases could not be loaded.';
      return;
    }

    const releases = payload.data;
    if (releases.length === 0) {
      region.dataset.releasesState = 'empty';
      status.className = 'text-muted';
      status.textContent = `${projectName} has no releases yet.`;
      return;
    }

    region.dataset.releasesState = 'ready';
    status.className = 'visually-hidden';
    status.textContent = `${releases.length} ${releases.length === 1 ? 'release' : 'releases'} for ${projectName}.`;

    content.innerHTML = `
      <div class="table-scroll" tabindex="0" role="group" aria-label="Releases table, scrolls horizontally">
        <table class="data-table" data-testid="release-list">
          <caption class="visually-hidden">Releases for ${escapeHtml(projectName)}, newest first</caption>
          <thead>
            <tr>
              <th scope="col">Version</th><th scope="col">Environment</th>
              <th scope="col">Revision</th><th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            ${releases.map((release) => `
              <tr data-testid="release-row" data-release-id="${escapeHtml(release.id)}">
                <th scope="row">${escapeHtml(release.version)}</th>
                <td>${escapeHtml(release.environment)}</td>
                <td><code>${escapeHtml(release.vcsRef)}</code></td>
                <td><span class="badge badge--${escapeHtml(release.status)}">${escapeHtml(STATUS_LABELS[release.status])}</span></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } catch {
    region.dataset.releasesState = 'unavailable';
    status.className = 'status-error';
    status.textContent = 'Foundation Lab is unreachable, so releases cannot be shown right now.';
  }
}
