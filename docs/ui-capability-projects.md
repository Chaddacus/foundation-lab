# UI Capability — Projects (create and list)

SPEC.md §13.4–§13.8 checklist, filled for slice 1. Subordinate to the root `SPEC.md`.

## Ownership

- **Module:** `projects` (`src/modules/projects/ui/`) · **Spine touchpoints:** the `[data-projects-root]` slot in `src/web/index.html`, `foundation.css` + `app.css` wiring, and the environment badge filled by `src/web/shell.js`.
- **Public contract consumed:** `ProjectsCapability` over the HTTP adapter (`GET /api/projects`, `POST /api/projects`).

## States — each applicable state is designed, reachable, and provable

| State | Applies? | Behavior | Proven by |
|---|---|---|---|
| loading | yes | `data-list-state="loading"`, `aria-busy="true"`, "Loading projects…" | `LOADING state is actually entered` — holds the response open and observes the state while live |
| ready | yes | Table of projects, newest first, with status badge | `empty state, create flow, and ready state work end to end`; semantics in `the table carries the semantics…` |
| empty | yes | "No projects yet. Add the first one using the form above." | same test; `proof-01-empty.png` inspected |
| partial | **no** | One small request with no partial-success mode. Deliberate N/A. | — |
| disabled | **yes** | When the caller is unauthorized the whole `fieldset` is disabled and says why. Previously mislabelled N/A: the form was left fully enabled in exactly the state where it could never succeed. | `UNAUTHORIZED state disables the create form`; `proof-07-unauthorized.png` |
| submitting | yes | Submit disabled, `aria-busy="true"`, label "Creating…"; a second click cannot create twice | `SUBMITTING state…` — request held open, state observed, double click asserted to yield one create |
| success | yes | Green summary `Created "<name>"`, form reset, focus returned to first field | create flow test; `proof-02-ready.png` inspected |
| error | yes | Per-field messages with `aria-invalid`, summary above the fields, reference id only when a trace exists | validation test; `proof-03-validation-error.png` inspected |
| unauthorized | yes | Status explains the state; the create form is disabled with a reason | `UNAUTHORIZED state…`; server-side 401 in `http-boundary.test.ts` |
| dependency/offline failure | yes | "Foundation Lab is unreachable… Try again shortly." | `UNAVAILABLE state` test; `proof-04-unavailable.png` |

Long-running work: none in slice 1 — creation is a single fast request, so no progress indicator is invented. Job state survival: N/A.

## Accessibility (WCAG 2.2 AA)

- [x] Native semantics first: `header`/`nav`/`main`, `table` with `caption` and `th scope`, real `label` elements. No ARIA roles beyond `alert` and `aria-live`.
- [x] Fully keyboard-operable; visible focus throughout — asserted, including computed `outlineWidth > 0`.
- [x] Forms: every control has an accessible name; errors associated via `aria-describedby` + `aria-invalid`; focus moves to the first failing field. `autocomplete="off"` only on the two identifier fields; no password fields exist, so password-manager compatibility is not applicable yet.
- [x] Status and error states announced: the **status line alone** is the live region (`role="status"`), and the form summary is `role="alert"`. The live region previously wrapped the table, so every create re-announced every row and cell on top of the success message.
- [x] Target sizes ≥ 24px (asserted on every control); status is carried by badge text as well as color.
- [x] Skip link clipped when unfocused and visible when focused — regression-tested after a visible-sliver defect.

## UX consistency

- Terms match the domain and the API: "project", "customer", "active".
- Risk-proportional friction: creating a project is reversible and cheap, so it needs no confirmation. No irreversible action exists in slice 1.
- Errors explain impact and recovery in plain language. The internal reference id is shown **only when a usable trace exists** — an unsampled request shows no reference rather than the all-zero trace id.
- Responsive intent: single column throughout; the project table scrolls inside its own container at **every** width, and that container is focusable so off-screen columns stay keyboard-reachable without relying on engine-specific scroll focus. No capability is hidden at any width. The page itself never scrolls horizontally — asserted at nine widths from 320px to 1440px, using a 118-character name that the application's own limit permits.

## Gaps carried out of slice 1

1. Chromium only. No browser support matrix is declared, so other engines are untested.
2. At small widths the scrolling table gives no visual affordance that more columns exist off-screen.
3. The heading that names the projects region is visually hidden, so the region is named for assistive technology but unlabelled visually. Deliberate, and worth revisiting in the slice-6 design pass.

## Completion proof

`npx playwright test` — 15 tests, all passing.

**Mutation-checked.** An earlier 9-test version of this suite passed unchanged against a build with the loading state, the submitting state, `aria-live`, the table `caption`, and every `th scope` removed — so its "Proven by" column was false. The current suite fails on that same mutation. Claims in the table above are written against what the tests actually observe.

Screenshots in `test-results/` were **inspected**, not merely produced. That inspection is what found the all-zero reference id and the skip-link sliver; independent browser verification then found the desktop horizontal overflow and the enabled-form-when-unauthorized defect. None of those four was caught by any assertion at the time.
