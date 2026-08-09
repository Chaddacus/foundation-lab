# UI Capability — Projects (create and list)

SPEC.md §13.4–§13.8 checklist, filled for slice 1. Subordinate to the root `SPEC.md`.

## Ownership

- **Module:** `projects` (`src/modules/projects/ui/`) · **Spine touchpoints:** the `[data-projects-root]` slot in `src/web/index.html`, `foundation.css` + `app.css` wiring, and the environment badge filled by `src/web/shell.js`.
- **Public contract consumed:** `ProjectsCapability` over the HTTP adapter (`GET /api/projects`, `POST /api/projects`).

## States — each applicable state is designed, reachable, and provable

| State | Applies? | Behavior | Proven by |
|---|---|---|---|
| loading | yes | `data-list-state="loading"`, `aria-busy="true"`, "Loading projects…" | `listSettled` transition asserted in every e2e test |
| ready | yes | Table of projects, newest first, with status badge | `empty state, create flow, and ready state work end to end` |
| empty | yes | "No projects yet. Add the first one using the form above." | same test; `proof-01-empty.png` inspected |
| partial | **no** | One small request with no partial-success mode. Deliberate N/A. | — |
| disabled | **no** | Slice 1 has no permission tier that renders the form disabled rather than absent. Revisit in slice 2. | — |
| submitting | yes | Submit button disabled, `aria-busy="true"`, label "Creating…" | create flow test (double submit impossible) |
| success | yes | Green summary `Created "<name>"`, form reset, focus returned to first field | create flow test; `proof-02-ready.png` inspected |
| error | yes | Per-field messages with `aria-invalid`, live-region summary, reference id when a trace exists | validation test; `proof-03-validation-error.png` inspected |
| unauthorized | yes | "You are not signed in, so projects cannot be shown." | server behavior proven in `http-boundary.test.ts` (DEV returns 401); UI branch not yet browser-proven — see Gaps |
| dependency/offline failure | yes | "Foundation Lab is unreachable… Try again shortly." | `UNAVAILABLE state` test; `proof-04-unavailable.png` |

Long-running work: none in slice 1 — creation is a single fast request, so no progress indicator is invented. Job state survival: N/A.

## Accessibility (WCAG 2.2 AA)

- [x] Native semantics first: `header`/`nav`/`main`, `table` with `caption` and `th scope`, real `label` elements. No ARIA roles beyond `alert` and `aria-live`.
- [x] Fully keyboard-operable; visible focus throughout — asserted, including computed `outlineWidth > 0`.
- [x] Forms: every control has an accessible name; errors associated via `aria-describedby` + `aria-invalid`; focus moves to the first failing field. `autocomplete="off"` only on the two identifier fields; no password fields exist, so password-manager compatibility is not applicable yet.
- [x] Status and error states announced: list region is `aria-live="polite"`, form summary is `role="alert"`.
- [x] Target sizes ≥ 24px (asserted on every control); status is carried by badge text as well as color.
- [x] Skip link clipped when unfocused and visible when focused — regression-tested after a visible-sliver defect.

## UX consistency

- Terms match the domain and the API: "project", "customer", "active".
- Risk-proportional friction: creating a project is reversible and cheap, so it needs no confirmation. No irreversible action exists in slice 1.
- Errors explain impact and recovery in plain language. The internal reference id is shown **only when a usable trace exists** — an unsampled request shows no reference rather than the all-zero trace id.
- Responsive intent: single column throughout; below 40rem the project table scrolls inside its own box. No capability is hidden at any width, and the page itself never scrolls horizontally (asserted).

## Gaps carried out of slice 1

1. The `unauthorized` UI branch is implemented and its server behavior is proven, but the branch itself has no browser proof — LOCAL always resolves a development actor. It becomes properly provable when real authentication lands in slice 2.
2. No independent `frontend-verifier` fresh-context verdict yet — see the slice-1 checkpoint.

## Completion proof

`npx playwright test` — 9 tests, all passing, stable across three consecutive runs. Screenshots `proof-01` … `proof-05` in `test-results/` were **inspected**, not merely produced; that inspection is what found the all-zero reference id and the skip-link sliver, neither of which any assertion had caught.
