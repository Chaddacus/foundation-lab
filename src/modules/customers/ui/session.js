/**
 * Customers — sign-in UI.
 *
 * Responsibility: render the sign-in form, exchange a credential for a session, and expose
 * the current session to the rest of the page.
 *
 * Place in the system: the Customers module's own UI. It owns the authentication surface;
 * no other module renders a login form or reads a credential.
 *
 * Boundary: the password is read from the form, sent once, and never stored, logged, or
 * placed in the URL. The session itself lives in an HttpOnly cookie this file cannot read —
 * which is the point: script-readable credentials are stealable by any injected script.
 */

const SESSION_API = '/api/session';

/**
 * Fetch the current session, or null when signed out.
 *
 * The endpoint answers `{ authenticated: false }` rather than 401 for an anonymous caller,
 * so a normal signed-out page load does not manufacture an error in the console.
 */
export async function currentSession() {
  try {
    const response = await fetch(SESSION_API, { headers: { 'content-type': 'application/json' } });
    if (!response.ok) return null;

    const { data } = await response.json();
    return data?.authenticated === true ? data : null;
  } catch {
    return null;
  }
}

/** Sign out and hand control back to the caller. Failure still clears local UI state. */
export async function signOut() {
  try {
    await fetch(SESSION_API, { method: 'DELETE', headers: { 'content-type': 'application/json' } });
  } catch {
    // A network failure must not trap someone in a signed-in-looking page.
  }
}

/**
 * Render the sign-in form into a container.
 *
 * `onSignedIn` is called with the session once authentication succeeds, so the shell
 * decides what to show next — this module does not know what the application contains.
 */
export function renderSignIn(container, onSignedIn) {
  container.innerHTML = `
    <form class="stack signin-form" data-testid="signin-form" novalidate>
      <h2>Sign in</h2>
      <p class="text-muted">Use your Foundation Lab account.</p>

      <div class="field">
        <label for="signin-email">Email</label>
        <input id="signin-email" name="email" type="email" autocomplete="username"
               required aria-describedby="signin-error" />
      </div>

      <div class="field">
        <label for="signin-password">Password</label>
        <input id="signin-password" name="password" type="password" autocomplete="current-password"
               required aria-describedby="signin-error" />
      </div>

      <p class="status-error" data-testid="signin-error" id="signin-error" role="alert" hidden></p>

      <div class="cluster">
        <button type="submit" data-testid="signin-submit">Sign in</button>
      </div>
    </form>
  `;

  const form = container.querySelector('[data-testid="signin-form"]');
  const error = container.querySelector('[data-testid="signin-error"]');
  const submit = container.querySelector('[data-testid="signin-submit"]');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    error.textContent = '';

    submit.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    submit.textContent = 'Signing in…';

    const data = Object.fromEntries(new FormData(form).entries());

    try {
      const response = await fetch(SESSION_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: data.email, password: data.password }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        // The server deliberately does not say which part was wrong; the UI must not
        // invent a more specific message, or it would undo that.
        error.hidden = false;
        error.textContent = payload.error?.message ?? 'Sign-in failed. Try again.';
        form.querySelector('#signin-password').value = '';
        form.querySelector('#signin-email').focus();
        return;
      }

      onSignedIn(payload.data);
    } catch {
      error.hidden = false;
      error.textContent = 'Foundation Lab is unreachable. Check your connection and try again.';
    } finally {
      submit.disabled = false;
      submit.removeAttribute('aria-busy');
      submit.textContent = 'Sign in';
    }
  });
}
