# Threat Model — Authentication and Tenant Authorization (slice 2)

Required by Standard 8 before meaningful changes to authentication and trust boundaries. Subordinate to `SPEC.md`.

Scope: introducing real authentication and tenant authorization, replacing the slice-1 unverified actor header. Written before implementation; decisions below are binding on the implementation.

## What changes

Slice 1 had no authentication. An unverified header named the actor in LOCAL, and every other environment refused all traffic. Slice 2 introduces users, passwords, sessions, and per-customer authorization, which creates trust boundaries that did not previously exist.

## Assets

| Asset | Class | Why it matters |
|---|---|---|
| Password verifiers | RESTRICTED | Recovery of one compromises an account, and users reuse passwords across systems |
| Session identifiers | RESTRICTED | Bearer credentials — possession IS authentication |
| Session signing secret | RESTRICTED | Forging it mints arbitrary sessions |
| User records (email, customer, role) | CONFIDENTIAL | Identifies people and their employer |
| Project and release records | INTERNAL | Tenant-visible business data |
| Deployment identity (env, version, revision) | INTERNAL | Already exposed via `/api/meta` to authenticated callers |

Foundation Lab holds no real customer data. The classes above describe how the code must behave, so the qualification exercises the real rules.

## Trust boundaries

1. **Network → application.** Everything in a request is attacker-controlled: path, headers, cookies, body, content type, origin.
2. **Unauthenticated → authenticated.** Crossed only by `login` presenting a valid credential. Two other routes are public but cross no boundary: sign-out (which only acts on a signature-verified id) and the session probe (which reports whether the caller is authenticated and queries nothing).
3. **Tenant → tenant.** An authenticated user of customer A must not reach customer B's data. This is the boundary the reference application most needs to prove, since it is the one real applications get wrong.
4. **User → elevated operations.** Deferred: slice 2 has no admin role. Stated so its absence is not mistaken for an implemented check.

## Threats and decisions

### Spoofing

- **Forged identity header.** The slice-1 defect: any non-empty header was accepted as identity. **Decision: the actor header is deleted entirely.** Identity comes only from a signed session cookie. No environment retains a header path, so there is no fallback to forget to disable.
- **Forged or guessed session id.** **Decision:** 256 bits from `crypto.randomBytes`, stored server-side; the cookie carries the id plus an HMAC-SHA-256 signature over it. An unsigned or mis-signed cookie is rejected before any database lookup.
- **Session fixation.** **Decision:** session ids are generated server-side and a client-supplied id is never adopted, so fixation *by id adoption* cannot occur. This does **not** close fixation by cookie injection from a sibling host, whose standard mitigation is the `__Host-` cookie prefix — absent today and not reachable while the application binds to loopback only (SPEC §9). It MUST be added before DEV or SANDBOX are exposed in slice 5. Existing sessions are deliberately left alive: destroying them would make signing in on a second device sign you out of the first, which is a single-session product policy rather than a security requirement.

### Tampering

- **Cookie modification.** Covered by the HMAC above, compared with `timingSafeEqual`.
- **Mass assignment through the JSON body.** A client sending `customerId`, `role`, or `id` must not be able to set them. **Decision:** modules read only the fields their normalizer names; ownership is taken from the authenticated session, never from the request body.

### Repudiation

- **Decision:** authentication outcomes are logged with `enduser.id` (the user id, never the email or password) and the trace id, through the existing correlated logger. Failures log the attempted email's *presence*, not its value.

### Information disclosure

- **Password verifier leak.** **Decision:** scrypt via `node:crypto` with a per-user random salt. Never logged, never returned by any capability, never placed in telemetry.
- **Session id leak.** **Decision:** cookie flags `HttpOnly`, `SameSite=Strict`, `Path=/`, and `Secure` in every environment except LOCAL — LOCAL is plain HTTP on loopback, and marking it `Secure` would silently break login rather than fail loudly.
- **Cross-tenant disclosure through error shape.** Returning `forbidden` for another tenant's project id confirms that id exists. **Decision: a resource belonging to another customer returns `not_found`, identically to a resource that does not exist.** `forbidden` is reserved for a resource the caller can see but may not act on — none exists in slice 2. The distinction is deliberate; the code must state it, or a later reader will "fix" it into a disclosure.
- **User enumeration at login.** **Decision:** one message for unknown email and wrong password, and the password hash is computed even when the user does not exist, so the timing does not separate the two.

### Denial of service

- **Password guessing.** **Decision:** per-account throttling after repeated failures, using a fixed lockout window. Not IP-based: this binds to loopback and IP throttling would be theatre here.
- **scrypt cost as an amplifier.** Login is the only endpoint that runs scrypt. The per-user lockout does NOT bound it: that lockout lives on a user row, so an unknown address could never be throttled, and hashing runs before the lock is honoured for timing symmetry. Measured, an unauthenticated login flood raised an authenticated read from ~1 ms to ~58 ms. **Decision:** an in-memory per-address throttle, consulted before any hashing and keyed regardless of account existence so it reveals nothing. **Residual:** an attacker using many distinct addresses is still bounded only by the machine; closing that needs a work queue or upstream rate limit and belongs with slice 5.
- **Malformed request crash.** Closed in the slice-1 review fixes; the regression tests stay.

### Elevation of privilege

- **Horizontal (tenant → tenant).** The main risk. **Decision: authorization is enforced inside the module service, not in an adapter and not in the UI.** Every read filters by the caller's customer, and every write re-checks ownership before mutating. HTTP and MCP therefore inherit the same rule, and the parity corpus covers unauthorized cases.
- **Authorization by prompt or tool description.** Prohibited by Standard 9. MCP tools receive the same authenticated actor and hit the same service checks.

### CSRF (carried over from the slice-1 review)

A cross-origin form could previously write as the development actor. **Decision:** `SameSite=Strict` on the session cookie, plus rejecting state-changing requests whose `Content-Type` is not `application/json` — a cross-site HTML form cannot send that content type without a preflight.

## Secrets

The session signing secret is the application's first real secret.

- It is read from configuration as a **reference**, never a literal in the repository (`rbw://` on this machine's personal plane, per SPEC §7).
- **LOCAL generates an ephemeral random secret at startup** when none is configured. This keeps a fresh clone runnable, and restarting invalidates sessions, which is correct for local work. It also means no developer is ever tempted to commit a shared literal.
- **Non-LOCAL refuses to start without a configured secret.** A missing secret must be a loud startup failure, never a silent default — a default signing key is indistinguishable from no signature at all.
- Backend unlock stays a human act. Nothing in this repository unlocks a vault or resolves a reference automatically.

## Residual risks accepted for slice 2

1. No password strength policy, rotation, or reset flow. Foundation Lab has no real users.
2. No multi-factor authentication.
3. No admin or role tier — every user has identical rights within their customer.
4. Sessions are stored in the application database, so horizontal scaling would need a shared store. Single-instance by design in slices 2–5.
5. No rate limit on non-login endpoints.
6. `Secure` is absent in LOCAL only; DEV and SANDBOX set it, and those run over loopback TLS or are re-examined in slice 5.
7. Login work is bounded per email address but not globally: an attacker using many distinct addresses is limited only by the machine. A work queue or upstream rate limit belongs with slice 5.
8. The `__Host-` cookie prefix is not set, so cookie injection from a sibling host is not closed. Not reachable while binding to loopback only; required before slice 5 exposes DEV or SANDBOX.

Each is recorded in `SPEC.md` §10 so it is disclosed rather than implied.

## What must be tested as behavior

Standard 8 requires authorization tested as behavior across boundaries, not asserted in prose:

- **Function:** an unauthenticated caller reaches no capability except the three public session routes. The assertion MUST be derived from the composed route table, not a hand-written list — a hand-written list left five routes uncovered, so marking any of them public passed the whole suite.
- **Object:** a user cannot read, update, or enumerate a specific project belonging to another customer.
- **Tenant:** listing returns only the caller's customer's records, proven with two populated customers rather than one.
- **Field:** a client-supplied `customerId` in a create or update body is ignored in favour of the session's customer.
- **Adapter:** every one of the above holds identically through MCP.
- **Mutation:** removing any single authorization check must fail at least one test.
