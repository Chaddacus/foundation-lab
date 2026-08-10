/**
 * Application shell behavior (UI spine).
 *
 * Responsibility: decide whether the application or the sign-in view is shown, wire the
 * global chrome, and connect capability modules to each other through their public UI
 * entry points.
 *
 * Place in the system: UI spine. It composes modules; it MUST NOT reach inside them. When
 * a project is selected, the shell tells the Releases module — Projects does not call
 * Releases directly, so neither module depends on the other.
 *
 * Boundary: the shell knows there is a session, not what a credential is. Authentication
 * belongs entirely to the Customers module.
 */

import { currentSession, renderSignIn, signOut } from '/modules/customers/session.js';
import { mountProjects, onProjectSelected } from '/modules/projects/projects.js';
import { mountReleases, showReleasesFor } from '/modules/releases/releases.js';

const signedOutView = document.querySelector('[data-testid="signed-out-view"]');
const signedInView = document.querySelector('[data-testid="signed-in-view"]');
const nav = document.querySelector('[data-testid="primary-nav"]');
const actorBadge = document.querySelector('[data-testid="actor-badge"]');
const signOutButton = document.querySelector('[data-testid="sign-out"]');
const environmentBadge = document.querySelector('[data-testid="environment-badge"]');

/**
 * Show which environment and revision is serving this page.
 *
 * On failure the badge reads "unknown" rather than assuming local. An environment label
 * that guesses is worse than one that admits it does not know.
 *
 * This is only attempted while signed in: `/api/meta` requires authentication, and a
 * signed-out page requesting it would produce a pointless 401 in the console.
 */
async function showDeploymentIdentity() {
  try {
    const response = await fetch('/api/meta', { headers: { 'content-type': 'application/json' } });
    if (!response.ok) throw new Error(`meta responded ${response.status}`);

    const { data } = await response.json();
    environmentBadge.textContent = data.environment;
    environmentBadge.title = `${data.serviceName} ${data.serviceVersion} · revision ${data.vcsRef} · artifact ${data.artifactDigest}`;
  } catch {
    environmentBadge.textContent = 'unknown';
    environmentBadge.title = 'Deployment identity could not be loaded.';
  }
}

/** Render the signed-in application. */
function showApplication(session) {
  signedOutView.hidden = true;
  signedInView.hidden = false;
  nav.hidden = false;

  actorBadge.hidden = false;
  // The email names the person; a raw uuid tells them nothing and needlessly surfaces an
  // internal identifier. The id is the fallback only if the email is somehow absent.
  actorBadge.textContent = session.email || session.userId;
  signOutButton.hidden = false;

  mountProjects(document.querySelector('[data-projects-root]'));
  mountReleases(document.querySelector('[data-releases-root]'));

  // Cross-module composition happens HERE, in the spine. Projects publishes a selection;
  // the shell passes it to Releases. Neither module imports the other.
  onProjectSelected((project) => {
    void showReleasesFor(project?.id ?? null, project?.name ?? '');
  });

  void showDeploymentIdentity();
}

/** Render the signed-out view. */
function showSignIn() {
  signedInView.hidden = true;
  signedOutView.hidden = false;
  nav.hidden = true;
  actorBadge.hidden = true;
  signOutButton.hidden = true;
  environmentBadge.textContent = '';

  renderSignIn(document.querySelector('[data-signin-root]'), (session) => showApplication(session));
  document.querySelector('#signin-email')?.focus();
}

signOutButton.addEventListener('click', async () => {
  await signOut();
  showSignIn();
});

const session = await currentSession();
if (session === null) showSignIn(); else showApplication(session);

document.body.dataset.shellReady = 'true';
