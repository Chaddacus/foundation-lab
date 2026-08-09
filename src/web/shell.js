/**
 * Application shell behavior (UI spine).
 *
 * Responsibility: fill the global chrome that is not owned by any capability module —
 * currently the deployment identity badge.
 *
 * Place in the system: UI spine. It MUST NOT touch module regions; the Projects module owns
 * everything inside `[data-projects-root]`.
 */

const badge = document.querySelector('[data-testid="environment-badge"]');

/**
 * Show which environment and revision is serving this page.
 *
 * On failure the badge reads "unknown" rather than assuming local. An environment label
 * that guesses is worse than one that admits it does not know — a reader would act on it.
 */
async function showDeploymentIdentity() {
  try {
    const response = await fetch('/api/meta');
    if (!response.ok) throw new Error(`meta responded ${response.status}`);

    const { data } = await response.json();
    badge.textContent = data.environment;
    badge.title = `${data.serviceName} ${data.serviceVersion} · revision ${data.vcsRef} · artifact ${data.artifactDigest}`;
  } catch {
    badge.textContent = 'unknown';
    badge.title = 'Deployment identity could not be loaded.';
  }
}

void showDeploymentIdentity();
