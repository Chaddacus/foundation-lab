/**
 * Projects — public capability contract.
 *
 * Responsibility: the single definition of what the Projects capability offers and the
 * shapes it accepts and returns.
 *
 * Place in the system: the public surface of the Projects module. Every consumer — the
 * HTTP adapter, the MCP adapter, the spine, and later modules — depends on THIS file and
 * nothing deeper inside the module (SPEC §3.2, §3.3).
 *
 * Boundary: types and the interface only. No persistence, no transport, no validation
 * implementation. Because both adapters implement the same interface, business logic
 * cannot legitimately diverge between API and MCP; `tests/contract` enforces that.
 */

import type { Actor } from '../../spine/actor.ts';

/**
 * Project lifecycle status.
 *
 * `active` → `archived`, one way. The value space existed from slice 1 so this became a
 * behavior change rather than a schema migration — which is exactly what it turned out to
 * be: no table was altered to add archiving.
 */
export type ProjectStatus = 'active' | 'archived';

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /**
   * Owning customer, and the tenant boundary every authorization check compares against.
   * Set from the authenticated session at creation and never changed afterwards.
   *
   * Projects MUST NOT read or write customer tables directly; it holds the id only.
   */
  readonly customerId: string;
  readonly status: ProjectStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Create input.
 *
 * There is no `customerId` field, deliberately. Ownership is taken from the authenticated
 * session, so a client cannot assign a project to another tenant. A body that includes
 * `customerId` is ignored rather than honoured — the field simply has no meaning here.
 */
export interface CreateProjectInput {
  readonly name: string;
  readonly description?: string;
}

/** Fields omitted are left unchanged. An update with no recognised field is a validation error. */
export interface UpdateProjectInput {
  readonly name?: string;
  readonly description?: string;
}

/**
 * The Projects capability.
 *
 * Every method takes the resolved `Actor` and is authorized against it: a project belonging
 * to another customer is reported as `not_found`, identically to one that does not exist,
 * so the error does not confirm the id is real. Ownership is set from the session at
 * creation and cannot be changed.
 *
 * Errors: implementations raise `AppError` — `validation` for bad input, `not_found` for
 * an unknown id. Adapters translate; they do not invent error semantics.
 */
export interface ProjectsCapability {
  createProject(actor: Actor, input: CreateProjectInput): Project;
  getProject(actor: Actor, id: string): Project;
  listProjects(actor: Actor): readonly Project[];
  updateProject(actor: Actor, id: string, input: UpdateProjectInput): Project;
  /**
   * Archive a project.
   *
   * One-way and idempotent-refusing: archiving an already-archived project raises
   * `conflict` rather than silently succeeding, so a caller can tell whether its action was
   * the one that took effect. Restoring is deliberately not provided — it is a separate
   * decision with its own consequences, not the inverse of a button.
   */
  archiveProject(actor: Actor, id: string): Project;
}
