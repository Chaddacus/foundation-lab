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
 * `archived` exists in the value space from slice 1 so the archive journey in slice 4 is a
 * behavior change, not a schema migration. Nothing transitions a project to `archived`
 * yet — see SPEC §10.2.
 */
export type ProjectStatus = 'active' | 'archived';

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /**
   * Owning customer. Slice 1 stores this as an opaque reference with no foreign key,
   * because the Customers module does not exist yet. Slice 2 adds the real reference and
   * authorizes against it. Projects MUST NOT read or write customer tables directly.
   */
  readonly customerId: string;
  readonly status: ProjectStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateProjectInput {
  readonly name: string;
  readonly description?: string;
  readonly customerId: string;
}

/** Fields omitted are left unchanged. An update with no recognised field is a validation error. */
export interface UpdateProjectInput {
  readonly name?: string;
  readonly description?: string;
}

/**
 * The Projects capability.
 *
 * Every method takes the resolved `Actor`. Slice 1 does not yet check the actor against
 * project ownership; the parameter is present so slice 2 implements authorization inside
 * the module instead of changing every adapter signature.
 *
 * Errors: implementations raise `AppError` — `validation` for bad input, `not_found` for
 * an unknown id. Adapters translate; they do not invent error semantics.
 */
export interface ProjectsCapability {
  createProject(actor: Actor, input: CreateProjectInput): Project;
  getProject(actor: Actor, id: string): Project;
  listProjects(actor: Actor): readonly Project[];
  updateProject(actor: Actor, id: string, input: UpdateProjectInput): Project;
}
